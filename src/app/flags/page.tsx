import { redirect } from "next/navigation";
import { getCurrentLeagueId } from "@/lib/auth/league";
import { getCurrentMember } from "@/lib/auth/member";
import { createClient } from "@/lib/supabase/server";
import {
  buildPreview,
  type LineGameRow,
  type MatchLineRow,
} from "@/lib/match/score-grid";
import type { ScoringConfig } from "@/lib/scoring/types";
import { correctLineup, finalizeMatch, resolveFlag } from "./actions";

type FlaggedMatch = {
  id: string;
  status: string;
  flag_comment: string | null;
  division_id: string;
  home_team_id: string | null;
  away_team_id: string | null;
};

export default async function FlagsPage() {
  const leagueId = await getCurrentLeagueId();
  if (!leagueId) redirect("/");
  const member = await getCurrentMember();
  if (!member) redirect("/login");

  const supabase = await createClient();

  // Commissioner gate is UX only — RLS enforces every action. We surface matches
  // the caller can actually act on by checking the resolver via has_perm.
  const { data: isComm } = await supabase.rpc("is_commissioner", {
    p_league: leagueId,
  });
  if (!isComm) {
    return (
      <main style={{ fontFamily: "system-ui", padding: "1.5rem" }}>
        <h1>Flag review</h1>
        <p>Only a commissioner can review flagged matches.</p>
      </main>
    );
  }

  const { data: flaggedData } = await supabase
    .from("match")
    .select("id, status, flag_comment, division_id, home_team_id, away_team_id")
    .eq("is_flagged", true);
  const flagged = (flaggedData ?? []) as FlaggedMatch[];

  if (flagged.length === 0) {
    return (
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 640 }}>
        <h1>Flag review</h1>
        <p>No flagged matches. 🎉</p>
      </main>
    );
  }

  const cards = await Promise.all(flagged.map((m) => renderCard(supabase, m)));

  return (
    <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 640 }}>
      <h1>Flag review</h1>
      <p>{flagged.length} flagged match{flagged.length === 1 ? "" : "es"} awaiting action.</p>
      {cards}
    </main>
  );
}

async function renderCard(
  supabase: Awaited<ReturnType<typeof createClient>>,
  m: FlaggedMatch,
) {
  const teamIds = [m.home_team_id, m.away_team_id].filter(Boolean) as string[];
  const { data: teamsData } = await supabase
    .from("team")
    .select("id, name")
    .in("id", teamIds);
  const teamName = new Map(
    ((teamsData ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]),
  );
  const homeName = teamName.get(m.home_team_id ?? "") ?? "Home";
  const awayName = teamName.get(m.away_team_id ?? "") ?? "Away";

  const { data: lineData } = await supabase
    .from("match_line")
    .select(
      "id, round_number, home_pair_index, away_pair_index, home_player1_id, home_player2_id, away_player1_id, away_player2_id",
    )
    .eq("match_id", m.id)
    .order("round_number")
    .order("home_pair_index");
  const lines = (lineData ?? []) as MatchLineRow[];

  const { data: gameData } = await supabase
    .from("line_game")
    .select("match_line_id, game_number, home_score, away_score, is_forfeit")
    .in("match_line_id", lines.map((l) => l.id));
  const games = (gameData ?? []) as LineGameRow[];

  // Read-only preview via the verified engine (config from division.scoring_format_id).
  let previewLine = "—";
  const { data: div } = await supabase
    .from("division")
    .select("scoring_format_id")
    .eq("id", m.division_id)
    .single();
  const sfId = (div as { scoring_format_id: string } | null)?.scoring_format_id;
  if (sfId) {
    const { data: sf } = await supabase
      .from("scoring_format")
      .select("config")
      .eq("id", sfId)
      .single();
    const config = (sf as { config: ScoringConfig } | null)?.config;
    if (config) {
      const p = buildPreview(lines, games, config, config.structure.games_per_line);
      const tail = p.complete
        ? p.winner === "tie"
          ? "TIE"
          : `winner ${p.winner === "home" ? homeName : awayName}`
        : `${p.entered}/${p.expected} games`;
      previewLine = `${awayName} ${p.awayPoints} — ${p.homePoints} ${homeName} · ${tail}`;
    }
  }

  // Rosters for pairing correction (per side).
  async function roster(teamId: string | null) {
    if (!teamId) return [] as { id: string; first_name: string; last_name: string }[];
    const { data } = await supabase
      .from("roster_entry")
      .select("member:member_id(id, first_name, last_name)")
      .eq("team_id", teamId);
    return ((data ?? []) as unknown as { member: { id: string; first_name: string; last_name: string } | null }[])
      .map((r) => r.member)
      .filter((x): x is { id: string; first_name: string; last_name: string } => x !== null);
  }
  const homeRoster = await roster(m.home_team_id);
  const awayRoster = await roster(m.away_team_id);

  const opts = (players: { id: string; first_name: string; last_name: string }[]) =>
    players.map((p) => (
      <option key={p.id} value={p.id}>
        {p.first_name} {p.last_name}
      </option>
    ));

  return (
    <section
      key={m.id}
      style={{ border: "1px solid #ddd", borderRadius: 8, padding: "1rem", margin: "1rem 0" }}
    >
      <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.1rem" }}>
        {awayName} @ {homeName} <span style={{ color: "#888", fontWeight: 400 }}>({m.status})</span>
      </h2>
      <p style={{ background: "#fff7e6", padding: "0.5rem 0.75rem", borderRadius: 6, margin: "0.5rem 0" }}>
        <strong>Flag:</strong> {m.flag_comment ?? "(no comment)"}
      </p>
      <p style={{ fontSize: "0.9rem", color: "#444" }}>Current result: {previewLine}</p>

      {/* Resolve */}
      <form action={resolveFlag} style={{ display: "grid", gap: "0.4rem", margin: "0.5rem 0" }}>
        <input type="hidden" name="match_id" value={m.id} />
        <label style={{ fontSize: "0.85rem" }}>
          Resolution note
          <textarea name="resolution" required rows={2} style={{ width: "100%", display: "block" }} />
        </label>
        <button type="submit">Resolve flag</button>
      </form>

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", margin: "0.5rem 0" }}>
        <a href={`/score?match=${m.id}`}>Correct scores →</a>
        {m.status !== "final" && (
          <form action={finalizeMatch}>
            <input type="hidden" name="match_id" value={m.id} />
            <button type="submit">Finalize match</button>
          </form>
        )}
      </div>

      {/* Pairing correction (lock-exempt, commissioner-only). */}
      <details>
        <summary style={{ cursor: "pointer", fontSize: "0.9rem" }}>Correct a pairing</summary>
        {(["home", "away"] as const).map((side) => {
          const players = side === "home" ? homeRoster : awayRoster;
          return (
            <form key={side} action={correctLineup} style={{ margin: "0.5rem 0", display: "grid", gap: "0.3rem" }}>
              <input type="hidden" name="match_id" value={m.id} />
              <input type="hidden" name="side" value={side} />
              <strong style={{ fontSize: "0.85rem" }}>{side === "home" ? homeName : awayName} pairs</strong>
              {["1", "2", "3"].map((pair) => (
                <div key={pair} style={{ display: "flex", gap: "0.3rem" }}>
                  <select name={`p${pair}a`} required defaultValue="">
                    <option value="" disabled>pair {pair} —</option>
                    {opts(players)}
                  </select>
                  <select name={`p${pair}b`} required defaultValue="">
                    <option value="" disabled>—</option>
                    {opts(players)}
                  </select>
                </div>
              ))}
              <button type="submit">Save {side} pairing</button>
            </form>
          );
        })}
      </details>
    </section>
  );
}
