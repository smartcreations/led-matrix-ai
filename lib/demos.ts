import type { Animation } from './animation';

/** Built-in demos; rgbOnly ones only make sense on a multicolor display. */
export const DEMOS: (Animation & { rgbOnly?: boolean })[] = [
  {
    title: 'Scrolling text',
    fps: 30,
    durationMs: 6000,
    code: `const msg = 'SMART CREATION LLC';
const x = w - p * (textWidth(msg) + w);
text(msg, x, (h - 7) / 2);`,
  },
  {
    title: 'Bouncing ball',
    fps: 30,
    durationMs: 4000,
    code: `const x = 3 + (w - 7) * (0.5 - 0.5 * Math.cos(2 * Math.PI * p));
const y = 3 + (h - 7) * (1 - Math.abs(Math.sin(2 * Math.PI * p * 4)));
ctx.beginPath();
ctx.arc(x, y, 2.6, 0, Math.PI * 2);
ctx.fill();`,
  },
  {
    title: 'Sine wave',
    fps: 30,
    durationMs: 2000,
    code: `for (let x = 0; x < w; x++) {
  const y = h / 2 + Math.sin(x / 8 + 2 * Math.PI * p) * (h / 2 - 2);
  setPixel(x, y);
}`,
  },
  {
    title: 'Rainbow plasma',
    rgbOnly: true,
    fps: 20,
    durationMs: 4000,
    code: `const a = 2 * Math.PI * p;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const v = Math.sin(x / 7 + a) + Math.sin(y / 5 - a) + Math.sin((x + y) / 9 + a);
    const hue = Math.round(((v + 3) / 6) * 360 + p * 360) % 360;
    setPixel(x, y, \`hsl(\${hue}, 100%, 50%)\`);
  }
}`,
  },
  {
    title: 'Rain',
    fps: 20,
    durationMs: 3000,
    code: `for (let x = 0; x < w; x += 3) {
  const seed = Math.sin(x * 12.9898) * 43758.5453;
  const span = h + 8;
  const offset = (seed - Math.floor(seed)) * span;
  const speed = 1 + ((x * 7) % 3);
  const y = (offset + p * span * speed) % span - 8;
  ctx.fillRect(x, y, 1, 3);
}`,
  },
];
