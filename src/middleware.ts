import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/** Extract the league subdomain from the Host header (dev + prod). */
function getSubdomain(host: string | null): string | null {
  if (!host) return null;
  const hostname = host.split(":")[0];
  const parts = hostname.split(".");
  // dev: desert.localhost -> "desert"
  if (hostname.endsWith("localhost")) return parts.length > 1 ? parts[0] : null;
  // prod: desert.example.com -> first label when 3+ labels
  return parts.length >= 3 ? parts[0] : null;
}

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refresh the session so Server Components can read it.
  await supabase.auth.getUser();

  // Resolve tenant from subdomain (public_league is anon-readable).
  const sub = getSubdomain(request.headers.get("host"));
  if (sub) {
    const { data: league } = await supabase
      .from("public_league")
      .select("id")
      .eq("subdomain", sub)
      .maybeSingle();
    if (!league) return new NextResponse("Unknown league", { status: 404 });
    response.headers.set("x-league-id", league.id as string);
    response.headers.set("x-league-subdomain", sub);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|login).*)"],
};
