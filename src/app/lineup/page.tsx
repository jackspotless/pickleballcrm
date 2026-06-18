import { redirect } from "next/navigation";
import { getCurrentLeagueId } from "@/lib/auth/league";
import { getCurrentMember } from "@/lib/auth/member";
import { createClient } from "@/lib/supabase/server";
import { submitLineup } from "./actions";

type Team = { id: string; name: string; home: boolean };
type RosterRow = {
  member: { id: string; first_name: string; last_name: string } | null;
};

export default async function LineupPage({
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
      <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
        <h1>Lineup</h1>
        <p>You are not a captain of any team.</p>
      </main>
    );
  }

  const teamIds = captainTeams.map((t) => t.id);
  const { data: matchesData } = await supabase
    .from("match")
    .select("id, week_number, home_team_id, away_team_id")
    .or(
      `home_team_id.in.(${teamIds.join(",")}),away_team_id.in.(${teamIds.join(",")})`,
    );
  const matches = (matchesData ?? []) as {
    id: string;
    week_number: number | null;
    home_team_id: string | null;
    away_team_id: string | null;
  }[];

  const matchId = searchParams.match;
  if (!matchId) {
    return (
      <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
        <h1>Lineup</h1>
        <p>Pick a match to set your lineup:</p>
        <ul>
          {matches.map((m) => (
            <li key={m.id}>
              <a href={`/lineup?match=${m.id}`}>
                {m.week_number ? `Week ${m.week_number} — ` : ""}match {m.id.slice(0, 8)}
              </a>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  const match = matches.find((m) => m.id === matchId);
  if (!match) redirect("/lineup");
  const myTeam: Team | undefined = captainTeams
    .map((t) => ({
      id: t.id,
      name: t.name,
      home: match.home_team_id === t.id,
    }))
    .find((t) => t.id === match.home_team_id || t.id === match.away_team_id);
  if (!myTeam) redirect("/lineup");
  const side = myTeam.home ? "home" : "away";

  const { data: rosterData } = await supabase
    .from("roster_entry")
    .select("member:member_id(id, first_name, last_name)")
    .eq("team_id", myTeam.id);
  const players = ((rosterData ?? []) as unknown as RosterRow[])
    .map((r) => r.member)
    .filter((m): m is NonNullable<RosterRow["member"]> => m !== null);

  const playerOptions = players.map((p) => (
    <option key={p.id} value={p.id}>
      {p.first_name} {p.last_name}
    </option>
  ));

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 520 }}>
      <h1>Lineup — {myTeam.name} ({side})</h1>
      <p>Assign 6 players into 3 pairs.</p>
      <form action={submitLineup} style={{ display: "grid", gap: "0.5rem" }}>
        <input type="hidden" name="match_id" value={matchId} />
        <input type="hidden" name="side" value={side} />
        {["1", "2", "3"].map((pair) => (
          <fieldset key={pair} style={{ display: "flex", gap: "0.5rem" }}>
            <legend>Pair {pair}</legend>
            <select name={`p${pair}a`} required>
              <option value="">—</option>
              {playerOptions}
            </select>
            <select name={`p${pair}b`} required>
              <option value="">—</option>
              {playerOptions}
            </select>
          </fieldset>
        ))}
        <button type="submit">Submit lineup</button>
      </form>
    </main>
  );
}
