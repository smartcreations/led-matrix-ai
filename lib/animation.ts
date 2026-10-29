import { FONT_5X7 } from './font';

export const WIDTH = 64;
export const HEIGHT = 32;

/** Bicolor panels show one LED color (on/off); multicolor panels show any RGB color. */
export type DisplayMode = 'mono' | 'rgb';

/**
 * One frame: HEIGHT rows of WIDTH values.
 * mono: each value is 0 (off) or 1 (on). rgb: each value is a packed 0xRRGGBB color, 0 is off.
 */
export type Frame = number[][];

/** One text() call while rendering: where it landed on the display, in pixels. */
export type TextDraw = { frame: number; str: string; x: number; y: number; scale: number; width: number };

export type Animation = {
  title: string;
  fps: number;
  durationMs: number;
  /** Body of `function draw(ctx, t, p, w, h, setPixel, text, textWidth)`. */
  code: string;
};

/**
 * Source of `renderFrames(newCanvas, FONT, job)`, shared by the browser's Web Worker and the
 * server's worker thread. Runs the generated draw() once per frame and returns the frames.
 */
export const RENDER_CORE = `
function renderFrames(newCanvas, FONT, { code, fps, durationMs, width, height, mode }, onText) {
  let frameIndex = 0;
  const canvas = newCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // on: truthy/falsy, or (in rgb mode) any CSS color string.
  const setPixel = (x, y, on = 1) => {
    const prev = ctx.fillStyle;
    ctx.fillStyle = typeof on === 'string' ? on : on ? '#fff' : '#000';
    ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    ctx.fillStyle = prev;
  };
  const text = (str, x, y) => {
    if (onText) {
      // Where the text really lands, through any translate/scale the code set.
      const m = ctx.getTransform();
      onText(frameIndex, { str: String(str), x: m.a * x + m.e, y: m.d * y + m.f, scale: m.a, width: textWidth(str) * m.a });
    }
    x = Math.round(x); y = Math.round(y);
    for (const ch of String(str).toUpperCase()) {
      const code = ch.charCodeAt(0);
      const glyph = FONT[code - 32] || FONT[31];
      for (let c = 0; c < 5; c++)
        for (let r = 0; r < 7; r++)
          if (glyph[c] & (1 << r)) ctx.fillRect(x + c, y + r, 1, 1);
      x += 6;
    }
  };
  const textWidth = (str) => Math.max(0, String(str).length * 6 - 1);
  const draw = new Function('ctx', 't', 'p', 'w', 'h', 'setPixel', 'text', 'textWidth', code);
  const count = Math.max(1, Math.round((durationMs * fps) / 1000));
  const frames = [];
  for (let i = 0; i < count; i++) {
    frameIndex = i;
    const t = (i * 1000) / fps;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    draw(ctx, t, i / count, width, height, setPixel, text, textWidth);
    const d = ctx.getImageData(0, 0, width, height).data;
    const rows = [];
    for (let y = 0; y < height; y++) {
      const row = new Array(width);
      for (let x = 0; x < width; x++) {
        const k = (y * width + x) * 4;
        if (mode === 'rgb') {
          const a = d[k + 3] / 255;
          const r = Math.round(d[k] * a), g = Math.round(d[k + 1] * a), b = Math.round(d[k + 2] * a);
          row[x] = Math.max(r, g, b) < 8 ? 0 : (r << 16) | (g << 8) | b;
        } else {
          const lum = ((0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]) * d[k + 3]) / 255;
          row[x] = lum > 127 ? 1 : 0;
        }
      }
      rows.push(row);
    }
    frames.push(rows);
  }
  return frames;
}
`;

// Runs inside a Web Worker so generated code can't touch the page.
const workerSource = `
const FONT = ${JSON.stringify(FONT_5X7)};
for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches']) {
  try { self[k] = undefined; } catch {}
}
${RENDER_CORE}
self.onmessage = (e) => {
  try {
    self.postMessage({ frames: renderFrames((w, h) => new OffscreenCanvas(w, h), FONT, e.data) });
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
`;

/** Renders an animation to an array of 0/1 frames, in a worker with a time limit. */
export function renderAnimation(anim: Animation, mode: DisplayMode = 'mono', timeoutMs = 4000): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    const worker = new Worker(url);
    const done = () => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error('Animation took too long to render'));
    }, timeoutMs);
    worker.onmessage = (e) => {
      done();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.frames);
    };
    worker.onerror = (e) => {
      done();
      reject(new Error(e.message || 'Worker error'));
    };
    worker.postMessage({ ...anim, width: WIDTH, height: HEIGHT, mode });
  });
}
