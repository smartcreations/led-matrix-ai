import { generateText, Output } from 'ai';
import { z } from 'zod';
import { HEIGHT, WIDTH } from '@/lib/animation';
import { suggestModel } from '@/lib/models';

export const dynamic = 'force-dynamic';

const FALLBACK = [
  'A heart that pulses in the center',
  'Fireworks bursting left to right',
  'A clock with ticking seconds',
  'Pac-Man chasing dots across the screen',
];

const FALLBACK_RGB = [
  'A sunset over rolling ocean waves',
  'Neon rainbow text saying HELLO',
  'Colorful fireworks over a city skyline',
  'A campfire with flickering orange flames',
];

/** Four short animation ideas to start the chat with; falls back to a fixed list on error or after 5s. */
export async function GET(req: Request) {
  const rgb = new URL(req.url).searchParams.get('mode') === 'rgb';
  try {
    const { output } = await generateText({
      model: suggestModel,
      abortSignal: AbortSignal.timeout(5000),
      output: Output.object({
        schema: z.object({ suggestions: z.array(z.string()).length(4) }),
      }),
      prompt: `Suggest 4 fun, varied animation ideas for a ${rgb ? 'full-color RGB' : 'single-color'} LED dot-matrix display that is ${WIDTH} pixels wide and ${HEIGHT} pixels tall.
Each idea is a request a user could type, at most 8 words, with no trailing period.
Keep them simple enough to read at this low resolution: shapes, motion, short text, patterns, tiny scenes.${rgb ? '\nMake them about color: rainbows, sunsets, neon, fire, colorful scenes.' : ''}
Random seed: ${Math.random().toString(36).slice(2, 8)}`,
    });
    return Response.json({ suggestions: output.suggestions });
  } catch (err) {
    console.error('Suggestions failed:', err);
    return Response.json({ suggestions: rgb ? FALLBACK_RGB : FALLBACK });
  }
}
