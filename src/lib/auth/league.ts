import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

/** The current tenant's league id, resolved by middleware from the subdomain. */
export async function getCurrentLeagueId(): Promise<string | null> {
  const h = await headers();
  return h.get("x-league-id");
}

/** The current league's public branding row (name, theme, colors, logo). */
export async function getCurrentLeague() {
  const id = await getCurrentLeagueId();
  if (!id) return null;
  const supabase = await createClient();
  const { data } = await supabase
    .from("public_league")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  return data;
}
