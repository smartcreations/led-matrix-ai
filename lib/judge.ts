import { createCanvas } from '@napi-rs/canvas';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { HEIGHT, WIDTH, type Animation, type DisplayMode, type Frame } from './animation';
import { routerModel } from './models';

// After an animation renders, a fast vision model looks at a few of its frames, drawn like the
// real LED panel, and says whether it shows what was asked. Turn it off with DEVICE_JUDGE=off.

export const judgeEnabled = process.env.DEVICE_JUDGE !== 'off';

const SHOWN = 6; // frames on the contact sheet
const LED = 5; // pixels per LED
const GAP = 12; // between frames

/** A PNG of SHOWN evenly spaced frames in a 2-column grid, each LED a dot on black. */
function contactSheet(frames: Frame[], mode: DisplayMode) {
  const cols = 2;
  const rows = Math.ceil(SHOWN / cols);
  const fw = WIDTH * LED;
  const fh = HEIGHT * LED;
  const canvas = createCanvas(cols * fw + (cols + 1) * GAP, rows * fh + (rows + 1) * GAP);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#333';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < SHOWN; i++) {
    const frame = frames[Math.floor((i * frames.length) / SHOWN)];
    const ox = GAP + (i % cols) * (fw + GAP);
    const oy = GAP + Math.floor(i / cols) * (fh + GAP);
    ctx.fillStyle = '#000';
    ctx.fillRect(ox, oy, fw, fh);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const v = frame[y][x];
        if (!v) continue;
        ctx.fillStyle = mode === 'mono' ? '#ff3b2f' : `#${v.toString(16).padStart(6, '0')}`;
        ctx.fillRect(ox + x * LED, oy + y * LED, LED - 1, LED - 1);
      }
    }
  }
  return canvas.toBuffer('image/png');
}

/** Fraction of LEDs lit across all frames. */
function litShare(frames: Frame[]) {
  let lit = 0;
  for (const f of frames) for (const row of f) for (const v of row) if (v) lit++;
  return lit / (frames.length * WIDTH * HEIGHT);
}

/**
 * Returns null when the animation looks right, or what's wrong with it, phrased as feedback
 * for the model that wrote it.
 */
export async function judgeAnimation(request: string, anim: Animation, frames: Frame[], mode: DisplayMode) {
  if (litShare(frames) < 0.005) return 'The display is almost completely dark. Draw bright, visible shapes.';
  const { output } = await generateText({
    model: routerModel,
    output: Output.object({
      schema: z.object({
        ok: z.boolean(),
        problem: z.string().describe('What to fix, in one or two sentences; empty when ok'),
      }),
    }),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `These are ${SHOWN} evenly spaced frames (left to right, top to bottom) of an animation on a ${WIDTH}x${HEIGHT} LED display. It loops every ${anim.durationMs} ms at ${anim.fps} fps.
It was made for: ${request}

Judge only what matters on a real LED panel. Is it ok? Say not ok only for clear problems:
- it doesn't show what was asked (wrong subject, or a wrong or missing answer)
- text is cut off at the edges without scrolling, overlaps, or is unreadable
- the important part is too small, too dim or lost in clutter
- scrolling text moves so far between frames that it would be hard to read`,
          },
          { type: 'image', image: contactSheet(frames, mode), mediaType: 'image/png' },
        ],
      },
    ],
  });
  return output && !output.ok && output.problem ? output.problem : null;
}
