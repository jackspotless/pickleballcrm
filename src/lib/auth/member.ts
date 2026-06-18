import { createClient } from "@/lib/supabase/server";

/**
 * The signed-in user's member row (full row, gated by RLS to their own league).
 * Returns null when unauthenticated.
 */
export async function getCurrentMember() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("member")
    .select("*")
    .eq("auth_user_id", user.id)
    .limit(1)
    .maybeSingle();
  return data;
}
