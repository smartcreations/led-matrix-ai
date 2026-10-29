import type { DisplayMode } from '@/lib/animation';
import { animationResponse, deviceAuthorized } from '@/lib/deviceAnimation';

export const maxDuration = 120;

/**
 * For LED screens: POST {"prompt": "make it snow", "mode": "rgb"} with
 * "Authorization: Bearer <DEVICE_KEY>". Replies with the animation in the player's
 * upload format (lib/lmx.ts), and its title in the X-Animation-Title header.
 */
export async function POST(req: Request) {
  if (!deviceAuthorized(req)) return new Response('Unauthorized', { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { prompt?: unknown; mode?: unknown };
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 500) : '';
  if (!prompt) return new Response('Missing prompt', { status: 400 });
  const mode: DisplayMode = body.mode === 'mono' ? 'mono' : 'rgb';
  return animationResponse(prompt, mode);
}
