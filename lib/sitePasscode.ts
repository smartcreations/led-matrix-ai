import { timingSafeEqual } from 'node:crypto';

// Guards the web page's AI routes (app/api/chat, app/api/suggestions) so strangers can't spend
// the AI key. The screens' routes (app/api/device) use DEVICE_KEY instead.

/** True when SITE_PASSCODE is unset (local development) or the request sends it as "X-Site-Passcode". */
export function siteAuthorized(req: Request) {
  const code = process.env.SITE_PASSCODE;
  if (!code) return true;
  const given = Buffer.from(req.headers.get('x-site-passcode') ?? '');
  const expected = Buffer.from(code);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
