import { redirect } from "next/navigation";
import { getCurrentLeagueId } from "@/lib/auth/league";
import { getCurrentMember } from "@/lib/auth/member";
import { createClient } from "@/lib/supabase/server";
import { createMatch } from "./actions";

export default async function SchedulePage() {
  const leagueId = await getCurrentLeagueId();
  if (!leagueId) redirect("/");
  const member = await getCurrentMember();
  if (!member) redirect("/login");

  const supabase = await createClient();

  // UX gate only — the match_write RLS policy is the real authorization.
  const { data: isCommissioner } = await supabase.rpc("is_commissioner", {
    p_league: leagueId,
  });
  if (!isCommissioner) {
    return (
      <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
        <h1>Scheduling</h1>
        <p>Commissioner access required.</p>
      </main>
    );
  }

  // season RLS already scopes to the current league; divisions ride along.
  const { data: seasons } = await supabase
    .from("season")
    .select("id, name, divisions:division(id, name)")
    .eq("league_id", leagueId);

  const divisions = (seasons ?? []).flatMap(
    (s: { name: string; divisions: { id: string; name: string }[] | null }) =>
      (s.divisions ?? []).map((d) => ({ id: d.id, label: `${s.name} — ${d.name}` })),
  );
  const divisionIds = divisions.map((d) => d.id);

  const teamsRes = divisionIds.length
    ? await supabase.from("team").select("id, name").in("division_id", divisionIds)
    : { data: [] };
  const teams: { id: string; name: string }[] = teamsRes.data ?? [];

  const matchesRes = divisionIds.length
    ? await supabase
        .from("match")
        .select("id, scheduled_at, week_number, home_team_id, away_team_id")
        .in("division_id", divisionIds)
        .order("week_number", { ascending: true })
    : { data: [] };
  const matches: {
    id: string;
    scheduled_at: string | null;
    week_number: number | null;
    home_team_id: string | null;
    away_team_id: string | null;
  }[] = matchesRes.data ?? [];

  const teamName = (id: string | null) =>
    teams.find((t) => t.id === id)?.name ?? "—";

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 640 }}>
      <h1>Scheduling</h1>

      <form action={createMatch} style={{ display: "grid", gap: "0.5rem", marginBottom: "2rem" }}>
        <label>
          Division
          <select name="division_id" required>
            {divisions.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </label>
        <label>
          Home team
          <select name="home_team_id" required>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        <label>
          Away team
          <select name="away_team_id" required>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        <label>
          Date/time
          <input type="datetime-local" name="scheduled_at" />
        </label>
        <label>
          Week
          <input type="number" name="week_number" min={1} />
        </label>
        <button type="submit">Create match</button>
      </form>

      <h2>Matches</h2>
      <ul>
        {matches.map((m) => (
          <li key={m.id}>
            {m.week_number ? `Wk ${m.week_number}: ` : ""}
            {teamName(m.away_team_id)} @ {teamName(m.home_team_id)}
            {m.scheduled_at ? ` — ${new Date(m.scheduled_at).toLocaleString()}` : ""}
          </li>
        ))}
      </ul>
    </main>
  );
}
