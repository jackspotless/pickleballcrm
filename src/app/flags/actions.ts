"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * Resolve a flag. Runs through the authenticated server client — the resolve_flag
 * RPC enforces commissioner-of-this-league, stamps the resolution record, and
 * touches ONLY the flag fields (decoupled from any score/pairing correction).
 */
export async function resolveFlag(formData: FormData) {
  const match_id = String(formData.get("match_id") ?? "");
  const resolution = String(formData.get("resolution") ?? "").trim();
  if (!match_id || !resolution) {
    throw new Error("match and a resolution note are required");
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("resolve_flag", {
    p_match: match_id,
    p_resolution: resolution,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/flags");
}

/**
 * Finalize a match (status -> final), locking captains out of further score
 * writes. A direct match update; RLS (match_write = commissioner) is the gate.
 * (Most matches reach 'final' automatically on scoring completion; this covers
 * the incomplete/abandoned case a commissioner closes by hand.)
 */
export async function finalizeMatch(formData: FormData) {
  const match_id = String(formData.get("match_id") ?? "");
  if (!match_id) throw new Error("match is required");
  const supabase = await createClient();
  const { error } = await supabase
    .from("match")
    .update({ status: "final" })
    .eq("id", match_id);
  if (error) throw new Error(error.message);
  revalidatePath("/flags");
}

/**
 * Correct a disputed pairing. The correct_lineup RPC is commissioner-only and
 * LOCK-EXEMPT (unlike submit_lineup), so a pairing can be re-set after the match
 * locks; the member-league trigger still validates the players.
 */
export async function correctLineup(formData: FormData) {
  const match_id = String(formData.get("match_id") ?? "");
  const side = String(formData.get("side") ?? "");
  const pairs = ["p1a", "p1b", "p2a", "p2b", "p3a", "p3b"].map((k) =>
    String(formData.get(k) ?? ""),
  );
  if (!match_id || !side || pairs.some((p) => !p)) {
    throw new Error("match, side, and all 6 players are required");
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("correct_lineup", {
    p_match: match_id,
    p_side: side,
    p_pairs: pairs,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/flags");
}
