import { timingSafeEqual } from 'node:crypto';
import { generateText, tool } from 'ai';
import { HEIGHT, WIDTH, type Animation, type DisplayMode } from './animation';
import { encodeAnimation } from './lmx';
import { deviceModel } from './models';
import { animationSchema, systemPrompt } from './prompt';
import { renderOnServer } from './renderServer';

// Shared by the LED screens' API routes (app/api/device): the screen's key check, and
// prompt → Claude → frames → the player's upload format.

/** True when the request carries "Authorization: Bearer <DEVICE_KEY>". */
export function deviceAuthorized(req: Request) {
  const key = process.env.DEVICE_KEY;
  const header = req.headers.get('authorization');
  if (!key || !header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The screen's local date and time, from the timezone Vercel works out from its IP address
 * (UTC elsewhere), so it can answer "what time is it?".
 */
export function localTime(req: Request) {
  const timeZone = req.headers.get('x-vercel-ip-timezone') ?? 'UTC';
  try {
    return new Date().toLocaleString('en-US', { timeZone, dateStyle: 'full', timeStyle: 'short' }) + ` (${timeZone})`;
  } catch {
    return new Date().toUTCString();
  }
}

// The screens get questions as well as animation ideas, and have no other way to answer.
const deviceInstructions = (now: string) => `

This display is a desk gadget people talk to. Always answer by calling createAnimation, never with text alone.
If they ask a question (the time, a fact, a quick calculation), answer it on the display: the answer as large, readable text, scrolling sideways if it is wider than the display, with a small fitting illustration or effect.
The current date and time where the display is: ${now}.`;

/**
 * Writes and draws an animation for `prompt` and replies with it in the upload format, with its
 * title (and `extraHeaders`) as headers. If the first code doesn't render, Claude gets the error
 * and one more try.
 */
export async function animationResponse(
  prompt: string,
  mode: DisplayMode,
  now: string,
  extraHeaders: Record<string, string> = {},
) {
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const anim = await writeAnimation(prompt + feedback, mode, now);
    if (!anim) return new Response('No animation was written', { status: 502 });
    try {
      const frames = await renderOnServer(anim, mode);
      const body = encodeAnimation(frames, anim.fps, mode);
      return new Response(Buffer.from(body), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(body.length),
          'X-Animation-Title': encodeURIComponent(anim.title),
          ...extraHeaders,
        },
      });
    } catch (e) {
      feedback = `\n\n(Your previous code failed with "${(e as Error).message}". Fix it.)`;
    }
  }
  return new Response('The animation could not be drawn', { status: 502 });
}

async function writeAnimation(prompt: string, mode: DisplayMode, now: string): Promise<Animation | null> {
  const { toolCalls } = await generateText({
    model: deviceModel,
    system: systemPrompt(mode) + deviceInstructions(now),
    toolChoice: { type: 'tool', toolName: 'createAnimation' },
    prompt,
    tools: {
      createAnimation: tool({
        description: `Show an animation on the ${WIDTH}x${HEIGHT} ${mode === 'rgb' ? 'full-color' : 'single-color'} LED display.`,
        inputSchema: animationSchema,
      }),
    },
  });
  const call = toolCalls.find((c) => c.toolName === 'createAnimation');
  return call ? (call.input as Animation) : null;
}
