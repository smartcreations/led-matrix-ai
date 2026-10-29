import { timingSafeEqual } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { generateText, tool } from 'ai';
import { HEIGHT, WIDTH, type Animation, type DisplayMode, type Frame } from './animation';
import { checkText, judgeAnimation, judgeEnabled } from './judge';
import { encodeAnimation } from './lmx';
import { deviceModel } from './models';
import { animationSchema, systemPrompt } from './prompt';
import { renderOnServer } from './renderServer';
import { answerPrompt, routePrompt, screenPlace } from './router';

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
The current date and time where the display is: ${now}.
Speed matters: the person is waiting. Keep the code short (under 40 lines), and make one loop 2 to 5 seconds long at 15 to 20 fps (scrolling text: as long as the scroll needs).`;

/**
 * Writes and draws an animation for `prompt` and replies with it in the upload format, with its
 * title (and `extraHeaders`) as headers. If the first code doesn't render, Claude gets the error
 * and one more try.
 */
export async function animationResponse(...args: Parameters<typeof makeAnimation>) {
  try {
    return await makeAnimation(...args);
  } catch (e) {
    // The screen prints the start of the reply, so the cause shows up in its log too.
    console.error('[device] failed:', e);
    return new Response(`Failed: ${(e as Error).message}`.slice(0, 200), { status: 500 });
  }
}

async function makeAnimation(
  req: Request,
  prompt: string,
  mode: DisplayMode,
  extraHeaders: Record<string, string> = {},
  timings: Record<string, number> = {},
) {
  // How long each stage takes, in the logs and the Server-Timing header.
  let mark = Date.now();
  const lap = (stage: string) => {
    timings[stage] = (timings[stage] ?? 0) + Date.now() - mark;
    mark = Date.now();
  };
  const report = (outcome: string) => {
    const parts = Object.entries(timings).map(([stage, ms]) => `${stage} ${ms}ms`);
    console.log(`[device] ${JSON.stringify(prompt)} → ${outcome} | ${parts.join(', ')}`);
    return Object.entries(timings).map(([stage, ms]) => `${stage};dur=${ms}`).join(', ');
  };

  const reply = (anim: Animation, frames: Frame[], outcome: string) => {
    const raw = encodeAnimation(frames, anim.fps, mode);
    // Raw frames are ~4 KB each and mostly black; screens that can unpack zlib get a reply
    // 5-20x smaller, which matters most on a slow hotspot.
    const zlib = req.headers.get('x-accept-compression')?.includes('zlib');
    const body = zlib ? deflateSync(raw, { level: 9 }) : Buffer.from(raw);
    return new Response(body, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
        ...(zlib && { 'X-Compression': 'zlib', 'X-Uncompressed-Length': String(raw.length) }),
        'X-Animation-Title': encodeURIComponent(anim.title),
        'X-Route': route,
        'Server-Timing': report(outcome),
        ...extraHeaders,
      },
    });
  };

  const now = localTime(req);
  // Most prompts are things to draw, so drawing starts while the router decides; a question
  // cancels it and draws the answer instead.
  const cancelDraft = new AbortController();
  const draft = writeAnimation(prompt, mode, now, cancelDraft.signal).catch(() => null);
  const route = await routePrompt(prompt);
  lap('route');
  if (route !== 'draw') cancelDraft.abort();
  let drawPrompt = prompt;
  if (route === 'answer') {
    const brief = await answerPrompt(prompt, now, screenPlace(req));
    lap('answer');
    drawPrompt = `Show this answer on the display. Write only the TEXT line's words on screen; draw the PICTURE, don't write it.\n${brief}\n(They asked: "${prompt}")`;
    console.log(`[device] answer: ${JSON.stringify(brief)}`);
  }

  // Up to two tries: the second gets the render error or the judge's notes on the first.
  let feedback = '';
  let fallback: { anim: Animation; frames: Frame[] } | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const anim =
      attempt === 0 && route === 'draw' ? await draft : await writeAnimation(drawPrompt + feedback, mode, now);
    lap('write');
    if (!anim) break;
    let frames: Frame[];
    let problem: string | null;
    try {
      const rendered = await renderOnServer(anim, mode);
      frames = rendered.frames;
      problem = checkText(rendered.texts, anim);
      lap('render');
    } catch (e) {
      lap('render');
      feedback = `\n\n(Your previous code failed with "${(e as Error).message}". Fix it.)`;
      continue;
    }
    if (attempt === 0 && !problem && judgeEnabled) {
      problem = await judgeAnimation(drawPrompt, anim, frames, mode).catch(() => null);
      lap('judge');
    }
    if (attempt === 0 && problem) {
      console.log(`[device] check: ${problem}`);
      fallback = { anim, frames };
      feedback = `\n\n(Your previous version had problems: ${problem} Fix them.)`;
      continue;
    }
    return reply(anim, frames, `${route}: "${anim.title}"${attempt ? ' (second try)' : ''}`);
  }
  if (fallback) return reply(fallback.anim, fallback.frames, `${route}: "${fallback.anim.title}" (checked, retry failed)`);
  report('failed');
  return new Response('The animation could not be drawn', { status: 502 });
}

async function writeAnimation(
  prompt: string,
  mode: DisplayMode,
  now: string,
  abortSignal?: AbortSignal,
): Promise<Animation | null> {
  const { toolCalls } = await generateText({
    model: deviceModel,
    abortSignal,
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
