"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * Create a match. Runs through the authenticated server client, so RLS
 * (match_write = commissioner of the division's league) is the real gate — the
 * page's commissioner check is UX only.
 */
export async function createMatch(formData: FormData) {
  const division_id = String(formData.get("division_id") ?? "");
  const home_team_id = String(formData.get("home_team_id") ?? "");
  const away_team_id = String(formData.get("away_team_id") ?? "");
  const scheduledRaw = String(formData.get("scheduled_at") ?? "");
  const weekRaw = String(formData.get("week_number") ?? "");

  if (!division_id || !home_team_id || !away_team_id) {
    throw new Error("division and both teams are required");
  }

  const supabase = await createClient();
  const { error } = await supabase.from("match").insert({
    division_id,
    home_team_id,
    away_team_id,
    scheduled_at: scheduledRaw || null,
    week_number: weekRaw ? Number(weekRaw) : null,
    match_type: "match",
    status: "scheduled",
  });
  if (error) throw new Error(error.message);

  revalidatePath("/schedule");
}
