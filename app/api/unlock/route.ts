import { siteAuthorized } from '@/lib/sitePasscode';

export const dynamic = 'force-dynamic';

/** Checks the "X-Site-Passcode" header without calling any AI: 204 when it's right (or not needed), else 401. */
export async function POST(req: Request) {
  return new Response(null, { status: siteAuthorized(req) ? 204 : 401 });
}
