"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * Submit a lineup for one side of a match. Calls the submit_lineup RPC, which
 * validates the caller is the captain of that side (or commissioner) and writes
 * only that side's columns — captains have no direct match_line write, so the
 * RPC is the boundary, not this action.
 */
export async function submitLineup(formData: FormData) {
  const match_id = String(formData.get("match_id") ?? "");
  const side = String(formData.get("side") ?? "");
  const pairs = ["p1a", "p1b", "p2a", "p2b", "p3a", "p3b"].map((k) =>
    String(formData.get(k) ?? ""),
  );

  if (!match_id || !side || pairs.some((p) => !p)) {
    throw new Error("match, side, and all 6 players are required");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("submit_lineup", {
    p_match: match_id,
    p_side: side,
    p_pairs: pairs,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/lineup");
}
