"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * Save game scores for a match. Writes line_game directly through the
 * authenticated server client — RLS (line_game_write = can_write_match,
 * either-captain) is the real authorization gate, and the scorability + lock
 * triggers enforce the boundaries. No service role anywhere on this path.
 *
 * Per game, a forfeit dropdown (ff_<matchLineId>_<gameNumber> = '', 'home',
 * 'away') overrides the typed scores: the named side forfeits 11-0 with
 * is_forfeit = true (the partial-forfeit affordance — mark some games 11-0 while
 * a player is late, enter real scores for the rest). Games left blank (no
 * scores, no forfeit) are not written.
 */
export async function saveScores(formData: FormData) {
  const match_id = String(formData.get("match_id") ?? "");
  if (!match_id) throw new Error("match is required");

  // Discover the (match_line, game) pairs present in the form.
  const ids = new Set<string>();
  for (const key of formData.keys()) {
    const m = /^g_([0-9a-f-]+)_(\d+)_(?:home|away)$/.exec(key);
    if (m) ids.add(`${m[1]}|${m[2]}`);
  }

  type Row = {
    match_line_id: string;
    game_number: number;
    home_score: number | null;
    away_score: number | null;
    is_forfeit: boolean;
  };
  const toWrite: Row[] = [];

  for (const id of ids) {
    const [mlId, gnStr] = id.split("|");
    const gameNumber = Number(gnStr);
    const ff = String(formData.get(`ff_${mlId}_${gameNumber}`) ?? "");

    let home: number | null = null;
    let away: number | null = null;
    let isForfeit = false;

    if (ff === "home") {
      home = 0;
      away = 11;
      isForfeit = true;
    } else if (ff === "away") {
      home = 11;
      away = 0;
      isForfeit = true;
    } else {
      const hs = String(formData.get(`g_${mlId}_${gameNumber}_home`) ?? "").trim();
      const as = String(formData.get(`g_${mlId}_${gameNumber}_away`) ?? "").trim();
      if (hs !== "" && as !== "") {
        home = Number(hs);
        away = Number(as);
        if (
          !Number.isInteger(home) ||
          !Number.isInteger(away) ||
          home < 0 ||
          away < 0
        ) {
          throw new Error("scores must be non-negative whole numbers");
        }
      }
    }

    // Only persist a game that is fully entered (both scores) or a forfeit.
    if (isForfeit || (home !== null && away !== null)) {
      toWrite.push({
        match_line_id: mlId,
        game_number: gameNumber,
        home_score: home,
        away_score: away,
        is_forfeit: isForfeit,
      });
    }
  }

  if (toWrite.length === 0) {
    revalidatePath("/score");
    return;
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("line_game")
    .upsert(toWrite, { onConflict: "match_line_id,game_number" });
  if (error) throw new Error(error.message);

  revalidatePath("/score");
}

/**
 * Whole-match no-show: record every game 11-0 against the losing side via the
 * forfeit_match RPC (one call instead of hand-typing eighteen 11-0 games). The
 * RPC validates either-captain authorization first.
 */
export async function forfeitMatch(formData: FormData) {
  const match_id = String(formData.get("match_id") ?? "");
  const loser_side = String(formData.get("loser_side") ?? "");
  if (!match_id || (loser_side !== "home" && loser_side !== "away")) {
    throw new Error("match and losing side are required");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("forfeit_match", {
    p_match: match_id,
    p_loser_side: loser_side,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/score");
}
