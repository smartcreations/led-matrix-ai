import { createCanvas } from '@napi-rs/canvas';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { DEFAULT_SIZE, type Animation, type DisplayMode, type DisplaySize, type Frame, type TextDraw } from './animation';
import { routerModel } from './models';

// Two checks on a rendered animation. checkText is instant: it looks at where every text()
// call landed. judgeAnimation shows frames, drawn like the real LED panel, to a vision model;
// it catches more but takes 3-9 s, so it's off unless DEVICE_JUDGE=on.

export const judgeEnabled = process.env.DEVICE_JUDGE === 'on';

const MAX_SCROLL_SPEED = 30; // pixels per second that are still easy to read

/**
 * Problems with the animation's text, as feedback for the model that wrote it, or null.
 * Text is cut off when it doesn't fit and doesn't move; moving text must go slowly enough to
 * read and far enough to show every letter.
 */
export function checkText(texts: TextDraw[], anim: Animation, { width: WIDTH, height: HEIGHT }: DisplaySize = DEFAULT_SIZE): string | null {
  const byString = new Map<string, TextDraw[]>();
  for (const t of texts) {
    if (!t.str.trim()) continue;
    const list = byString.get(t.str) ?? [];
    list.push(t);
    byString.set(t.str, list);
  }
  const problems: string[] = [];
  for (const [str, draws] of byString) {
    // The same string drawn more than once per frame (letters drawn one by one, repeated
    // labels) can't be told apart from frame to frame, so it isn't checked.
    if (new Set(draws.map((d) => d.frame)).size < draws.length) continue;
    const label = str.length > 30 ? `${str.slice(0, 30)}…` : str;
    const xs = draws.map((d) => d.x);
    const ys = draws.map((d) => d.y);
    const width = Math.max(...draws.map((d) => d.width));
    const height = 7 * Math.max(...draws.map((d) => d.scale));
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const movesSideways = maxX - minX >= 1;
    if (!movesSideways && (minX < -0.5 || minX + width > WIDTH + 0.5)) {
      problems.push(
        `"${label}" is ${Math.round(width)} px wide and cut off on the ${WIDTH} px display without scrolling. Shorten it, split it over two lines, or scroll it.`,
      );
    }
    if (movesSideways) {
      // Speed from the same text in consecutive frames.
      const steps: number[] = [];
      const sorted = [...draws].sort((a, b) => a.frame - b.frame);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].frame === sorted[i - 1].frame + 1) steps.push(Math.abs(sorted[i].x - sorted[i - 1].x));
      }
      steps.sort((a, b) => a - b);
      const speed = (steps[Math.floor(steps.length / 2)] ?? 0) * anim.fps;
      if (speed > MAX_SCROLL_SPEED) {
        problems.push(
          `"${label}" scrolls at ${Math.round(speed)} px/s, too fast to read. Move it 1 px per frame at 15-20 fps and make durationMs long enough for the whole text to pass.`,
        );
      }
      if (width > WIDTH && (minX > WIDTH - width + 0.5 || maxX < -0.5)) {
        problems.push(
          `"${label}" doesn't scroll far enough to show every letter. Scroll it from x = w to x = -textWidth(str) over the loop.`,
        );
      }
    }
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    if (maxY - minY < 1 && (minY < -0.5 || minY + height > HEIGHT + 0.5)) {
      problems.push(`"${label}" is cut off at the ${minY < 0 ? 'top' : 'bottom'} of the display.`);
    }
  }
  return problems.length ? problems.join(' ') : null;
}

const SHOWN = 6; // frames on the contact sheet
const SHEET_WIDTH = 320; // of one frame, so LEDs shrink on finer displays
const GAP = 12; // between frames

/** A PNG of SHOWN evenly spaced frames in a 2-column grid, each LED a dot on black. */
function contactSheet(frames: Frame[], mode: DisplayMode, { width: WIDTH, height: HEIGHT }: DisplaySize) {
  const cols = 2;
  const rows = Math.ceil(SHOWN / cols);
  const LED = Math.round(SHEET_WIDTH / WIDTH);
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
function litShare(frames: Frame[], { width: WIDTH, height: HEIGHT }: DisplaySize) {
  let lit = 0;
  for (const f of frames) for (const row of f) for (const v of row) if (v) lit++;
  return lit / (frames.length * WIDTH * HEIGHT);
}

/**
 * Returns null when the animation looks right, or what's wrong with it, phrased as feedback
 * for the model that wrote it.
 */
export async function judgeAnimation(
  request: string,
  anim: Animation,
  frames: Frame[],
  mode: DisplayMode,
  size: DisplaySize = DEFAULT_SIZE,
) {
  const { width: WIDTH, height: HEIGHT } = size;
  if (litShare(frames, size) < 0.005) return 'The display is almost completely dark. Draw bright, visible shapes.';
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
          { type: 'image', image: contactSheet(frames, mode, size), mediaType: 'image/png' },
        ],
      },
    ],
  });
  return output && !output.ok && output.problem ? output.problem : null;
}
