import { redirect } from "next/navigation";
import { getCurrentLeagueId } from "@/lib/auth/league";
import { getCurrentMember } from "@/lib/auth/member";
import { createClient } from "@/lib/supabase/server";
import {
  buildPreview,
  isScorable,
  type LineGameRow,
  type MatchLineRow,
} from "@/lib/match/score-grid";
import type { ScoringConfig } from "@/lib/scoring/types";
import { forfeitMatch, saveScores } from "./actions";

type MatchRow = {
  id: string;
  week_number: number | null;
  division_id: string;
  home_team_id: string | null;
  away_team_id: string | null;
  status: string;
};

const cell: React.CSSProperties = {
  width: "3.5rem",
  fontSize: "1.25rem",
  textAlign: "center",
  padding: "0.4rem",
};

function name(
  id: string | null,
  members: Map<string, string>,
): string {
  return (id && members.get(id)) || "—";
}

export default async function ScorePage({
  searchParams,
}: {
  searchParams: { match?: string };
}) {
  const leagueId = await getCurrentLeagueId();
  if (!leagueId) redirect("/");
  const member = await getCurrentMember();
  if (!member) redirect("/login");
  const memberId = (member as { id: string }).id;

  const supabase = await createClient();

  const { data: captainTeamsData } = await supabase
    .from("team")
    .select("id, name")
    .or(`captain_member_id.eq.${memberId},cocaptain_member_id.eq.${memberId}`);
  const captainTeams = (captainTeamsData ?? []) as { id: string; name: string }[];

  if (captainTeams.length === 0) {
    return (
      <main style={{ fontFamily: "system-ui", padding: "1.5rem" }}>
        <h1>Score entry</h1>
        <p>You are not a captain of any team.</p>
      </main>
    );
  }

  const teamIds = captainTeams.map((t) => t.id);
  const { data: matchesData } = await supabase
    .from("match")
    .select("id, week_number, division_id, home_team_id, away_team_id, status")
    .or(
      `home_team_id.in.(${teamIds.join(",")}),away_team_id.in.(${teamIds.join(",")})`,
    );
  const matches = (matchesData ?? []) as MatchRow[];

  const matchId = searchParams.match;
  if (!matchId) {
    return (
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 560 }}>
        <h1>Score entry</h1>
        <p>Pick a match to enter scores:</p>
        <ul>
          {matches.map((m) => (
            <li key={m.id}>
              <a href={`/score?match=${m.id}`}>
                {m.week_number ? `Week ${m.week_number} — ` : ""}match {m.id.slice(0, 8)} ({m.status})
              </a>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  const match = matches.find((m) => m.id === matchId);
  if (!match) redirect("/score");

  // Team names for the two sides.
  const { data: teamsData } = await supabase
    .from("team")
    .select("id, name")
    .in("id", [match.home_team_id, match.away_team_id].filter(Boolean) as string[]);
  const teamName = new Map(
    ((teamsData ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]),
  );
  const homeName = teamName.get(match.home_team_id ?? "") ?? "Home";
  const awayName = teamName.get(match.away_team_id ?? "") ?? "Away";

  // Match_line rows (the pairings, carried through the rounds).
  const { data: lineData } = await supabase
    .from("match_line")
    .select(
      "id, round_number, home_pair_index, away_pair_index, home_player1_id, home_player2_id, away_player1_id, away_player2_id",
    )
    .eq("match_id", matchId)
    .order("round_number")
    .order("home_pair_index");
  const lines = (lineData ?? []) as MatchLineRow[];

  if (!isScorable(lines)) {
    return (
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 560 }}>
        <h1>{awayName} @ {homeName}</h1>
        <p style={{ background: "#fff7e6", padding: "0.75rem", borderRadius: 8 }}>
          <strong>Waiting for lineups.</strong> Both teams must submit their
          lineups before scores can be entered.
        </p>
        <p><a href="/score">← back to matches</a></p>
      </main>
    );
  }

  // Player names.
  const playerIds = [
    ...new Set(
      lines.flatMap((l) => [
        l.home_player1_id,
        l.home_player2_id,
        l.away_player1_id,
        l.away_player2_id,
      ]),
    ),
  ].filter((x): x is string => !!x);
  const { data: memberData } = await supabase
    .from("member")
    .select("id, first_name, last_name")
    .in("id", playerIds);
  const members = new Map(
    ((memberData ?? []) as { id: string; first_name: string; last_name: string }[]).map(
      (m) => [m.id, `${m.first_name} ${m.last_name}`.trim()],
    ),
  );

  // Existing scores.
  const lineIds = lines.map((l) => l.id);
  const { data: gameData } = await supabase
    .from("line_game")
    .select("match_line_id, game_number, home_score, away_score, is_forfeit")
    .in("match_line_id", lineIds);
  const games = (gameData ?? []) as LineGameRow[];
  const gameByKey = new Map(
    games.map((g) => [`${g.match_line_id}_${g.game_number}`, g]),
  );

  // Config — resolved through division.scoring_format_id, the SAME path the CI
  // anchor-verify uses to feed scoreMatch (post-rule_set refactor this column is
  // authoritative; season.rule_set.scoring_format_id mirrors it). The preview
  // therefore reads from the same source as the verified scorer.
  const { data: div } = await supabase
    .from("division")
    .select("scoring_format_id")
    .eq("id", match.division_id)
    .single();
  const { data: sf } = await supabase
    .from("scoring_format")
    .select("config")
    .eq("id", (div as { scoring_format_id: string }).scoring_format_id)
    .single();
  const config = (sf as { config: ScoringConfig }).config;
  const gamesPerLine = config.structure.games_per_line;

  const preview = buildPreview(lines, games, config, gamesPerLine);
  const locked = match.status !== "scheduled";

  // Group lines by round for a mobile-friendly layout.
  const rounds = [...new Set(lines.map((l) => l.round_number))].sort((a, b) => a - b);

  return (
    <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 560 }}>
      <h1 style={{ fontSize: "1.4rem" }}>{awayName} @ {homeName}</h1>

      {/* Read-only live preview (engine totals; no winner until complete). */}
      <section
        style={{
          background: "#f0f7ff",
          padding: "0.75rem 1rem",
          borderRadius: 8,
          margin: "0.5rem 0 1rem",
        }}
      >
        <div style={{ fontSize: "1.6rem", fontWeight: 700 }}>
          {awayName} {preview.awayPoints} — {preview.homePoints} {homeName}
        </div>
        <div style={{ fontSize: "0.85rem", color: "#555" }}>
          rounds won {preview.homeRoundsWon}–{preview.awayRoundsWon} ·{" "}
          {preview.entered}/{preview.expected} games in
          {preview.complete
            ? preview.winner === "tie"
              ? " · TIE"
              : ` · winner ${preview.winner === "home" ? homeName : awayName}`
            : " · in progress"}
        </div>
        {preview.perRound.length > 0 && (
          <div style={{ fontSize: "0.8rem", color: "#666", marginTop: 4 }}>
            {preview.perRound.map((r) => (
              <span key={r.round} style={{ marginRight: 12 }}>
                R{r.round}: {r.away}-{r.home}
              </span>
            ))}
          </div>
        )}
      </section>

      <form action={saveScores} style={{ display: "grid", gap: "1rem" }}>
        <input type="hidden" name="match_id" value={matchId} />
        {rounds.map((round) => (
          <fieldset key={round} style={{ border: "1px solid #ddd", borderRadius: 8 }}>
            <legend style={{ fontWeight: 600 }}>Round {round}</legend>
            {lines
              .filter((l) => l.round_number === round)
              .map((l) => {
                const homePair = `${name(l.home_player1_id, members)} / ${name(l.home_player2_id, members)}`;
                const awayPair = `${name(l.away_player1_id, members)} / ${name(l.away_player2_id, members)}`;
                return (
                  <div key={l.id} style={{ marginBottom: "0.75rem" }}>
                    <div style={{ fontSize: "0.85rem", color: "#444" }}>
                      <strong>{awayPair}</strong> vs <strong>{homePair}</strong>
                    </div>
                    {Array.from({ length: gamesPerLine }, (_, i) => i + 1).map((gn) => {
                      const g = gameByKey.get(`${l.id}_${gn}`);
                      return (
                        <div
                          key={gn}
                          style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: 4 }}
                        >
                          <span style={{ width: "3.5rem", fontSize: "0.8rem" }}>Game {gn}</span>
                          <input
                            style={cell}
                            type="number"
                            inputMode="numeric"
                            min={0}
                            name={`g_${l.id}_${gn}_away`}
                            aria-label={`${awayName} game ${gn} score`}
                            defaultValue={g?.away_score ?? ""}
                          />
                          <span>–</span>
                          <input
                            style={cell}
                            type="number"
                            inputMode="numeric"
                            min={0}
                            name={`g_${l.id}_${gn}_home`}
                            aria-label={`${homeName} game ${gn} score`}
                            defaultValue={g?.home_score ?? ""}
                          />
                          <select
                            name={`ff_${l.id}_${gn}`}
                            defaultValue=""
                            aria-label={`forfeit game ${gn}`}
                            style={{ fontSize: "0.8rem" }}
                          >
                            <option value="">played</option>
                            <option value="away">{awayName} forfeits</option>
                            <option value="home">{homeName} forfeits</option>
                          </select>
                          {g?.is_forfeit && <span title="forfeit">⚑</span>}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
          </fieldset>
        ))}
        <button type="submit" style={{ padding: "0.75rem", fontSize: "1rem" }}>
          Save scores
        </button>
      </form>

      {/* Whole-match no-show. */}
      <form
        action={forfeitMatch}
        style={{ marginTop: "1.5rem", paddingTop: "1rem", borderTop: "1px solid #eee" }}
      >
        <input type="hidden" name="match_id" value={matchId} />
        <label style={{ fontSize: "0.85rem" }}>
          Whole-match forfeit (records every game 11-0):{" "}
          <select name="loser_side" defaultValue="">
            <option value="" disabled>
              which team forfeits?
            </option>
            <option value="away">{awayName} forfeits</option>
            <option value="home">{homeName} forfeits</option>
          </select>
        </label>{" "}
        <button type="submit">Apply forfeit</button>
      </form>

      {locked && (
        <p style={{ fontSize: "0.8rem", color: "#888", marginTop: "1rem" }}>
          Scoring has started — lineups are locked for this match.
        </p>
      )}
      <p style={{ marginTop: "1rem" }}><a href="/score">← back to matches</a></p>
    </main>
  );
}
