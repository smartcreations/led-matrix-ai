import { z } from 'zod';
import { HEIGHT, WIDTH, type DisplayMode } from './animation';

// Instructions and tool schema for writing animations; shared by the chat and the screens' API.

const MONO = {
  display: 'a single-color (bicolor: on/off) LED dot-matrix display',
  ctx: 'fillStyle and strokeStyle are white.',
  setPixel: 'setPixel(x, y, on = 1): set one LED.',
  rules:
    '${m.rules}',
};

const RGB = {
  display: 'a full-color RGB LED dot-matrix display',
  ctx: 'fillStyle and strokeStyle start as white; set them to any CSS color (hex, rgb(), hsl()) or gradient.',
  setPixel: "setPixel(x, y, color = '#fff'): set one LED to any CSS color string.",
  rules:
    'Every pixel keeps its color, and black means the LED is off. Design colorful animations: use hsl() hues, gradients and contrasting colors. Keep shapes at least 1px wide and bright; dim colors look off on real LEDs.',
};

export const systemPrompt = (mode: DisplayMode) => {
  const m = mode === 'rgb' ? RGB : MONO;
  return `You design animations for ${m.display} that is ${WIDTH} pixels wide and ${HEIGHT} pixels tall.
Whenever the user describes or changes an animation, call the createAnimation tool with the complete code, then reply with one short sentence.

The code is the BODY of this function, called once per frame:
  function draw(ctx, t, p, w, h, setPixel, text, textWidth) { ... }
- ctx: CanvasRenderingContext2D for a ${WIDTH}x${HEIGHT} canvas, cleared to black before every frame. ${m.ctx}
- t: milliseconds since start. p: loop progress from 0 to 1 (exclusive). Use p so the animation loops seamlessly.
- w = ${WIDTH}, h = ${HEIGHT}.
- ${m.setPixel}
- text(str, x, y): draw crisp 5x7 pixel text in the current fillStyle (uppercase A-Z, digits, punctuation); each character is 6px wide, 7px tall.
- textWidth(str): width in pixels of text(str).
Every pixel is thresholded to on/off, so draw in pure white and avoid thin anti-aliased shapes; prefer fillRect, setPixel and filled arcs.
The function must be pure: compute everything from t or p, keep no state between frames, and use no timers, network or DOM.
Keep code under 80 lines. Pick fps between 10 and 30 and durationMs between 1000 and 10000.
On follow-up requests, return the full updated code, not a diff.`;
};

/** Arguments of the createAnimation tool. */
export const animationSchema = z.object({
  title: z.string().describe('Short name for the animation'),
  fps: z.number().int().min(1).max(60),
  durationMs: z.number().int().min(100).max(20000).describe('Length of one loop'),
  code: z.string().describe('Body of draw(ctx, t, p, w, h, setPixel, text, textWidth)'),
});
