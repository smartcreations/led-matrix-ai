import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  tool,
  type UIMessage,
} from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { HEIGHT, WIDTH } from '@/lib/animation';

export const maxDuration = 60;

// With ANTHROPIC_API_KEY set, call Anthropic directly; otherwise use the AI Gateway
// (AI_GATEWAY_API_KEY), where any gateway model id works, including Google Gemini models.
const MODEL = process.env.ANTHROPIC_API_KEY
  ? anthropic(process.env.LED_MODEL ?? 'claude-sonnet-5-5')
  : (process.env.LED_MODEL ?? 'anthropic/claude-sonnet-5.5');

const SYSTEM = `You design animations for a monochrome LED dot-matrix display that is ${WIDTH} pixels wide and ${HEIGHT} pixels tall.
Whenever the user describes or changes an animation, call the createAnimation tool with the complete code, then reply with one short sentence.

The code is the BODY of this function, called once per frame:
  function draw(ctx, t, p, w, h, setPixel, text, textWidth) { ... }
- ctx: CanvasRenderingContext2D for a ${WIDTH}x${HEIGHT} canvas, cleared to black before every frame. fillStyle and strokeStyle are white.
- t: milliseconds since start. p: loop progress from 0 to 1 (exclusive). Use p so the animation loops seamlessly.
- w = ${WIDTH}, h = ${HEIGHT}.
- setPixel(x, y, on = 1): set one LED.
- text(str, x, y): draw crisp 5x7 pixel text (uppercase A-Z, digits, punctuation); each character is 6px wide, 7px tall.
- textWidth(str): width in pixels of text(str).
Every pixel is thresholded to on/off, so draw in pure white and avoid thin anti-aliased shapes; prefer fillRect, setPixel and filled arcs.
The function must be pure: compute everything from t or p, keep no state between frames, and use no timers, network or DOM.
Keep code under 80 lines. Pick fps between 10 and 30 and durationMs between 1000 and 10000.
On follow-up requests, return the full updated code, not a diff.`;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: MODEL,
    system: SYSTEM,
    messages: await convertToModelMessages(messages),
    tools: {
      createAnimation: tool({
        description: `Show an animation on the ${WIDTH}x${HEIGHT} LED display.`,
        inputSchema: z.object({
          title: z.string().describe('Short name for the animation'),
          fps: z.number().int().min(1).max(60),
          durationMs: z.number().int().min(100).max(20000).describe('Length of one loop'),
          code: z.string().describe('Body of draw(ctx, t, p, w, h, setPixel, text, textWidth)'),
        }),
        // Rendering happens in the browser; the server just acknowledges.
        execute: async ({ title }) => ({ shown: title }),
      }),
    },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
