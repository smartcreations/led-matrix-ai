import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import '@napi-rs/canvas'; // so the deployment includes it; the worker loads it by path
import { DEFAULT_SIZE, RENDER_CORE, type Animation, type DisplayMode, type DisplaySize, type Frame, type TextDraw } from './animation';
import { FONT_5X7 } from './font';

// Generated code runs in a worker thread with an empty environment (no API keys), no network
// globals, a memory cap and a time limit. It's the server-side twin of the browser's Web Worker.
const workerSource = (canvasPath: string) => `
const { parentPort, workerData } = require('node:worker_threads');
const { createCanvas } = require(${JSON.stringify(canvasPath)});
const FONT = ${JSON.stringify(FONT_5X7)};
for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Request', 'Response', 'Headers']) {
  try { globalThis[k] = undefined; } catch {}
}
${RENDER_CORE}
try {
  const texts = [];
  const frames = renderFrames(createCanvas, FONT, workerData, (frame, t) => texts.push({ frame, ...t }));
  parentPort.postMessage({ frames, texts });
} catch (err) {
  parentPort.postMessage({ error: String((err && err.message) || err) });
}
`;

const canvasPath = createRequire(path.join(process.cwd(), 'package.json')).resolve('@napi-rs/canvas');

/** Renders an animation to frames on the server, with every text() call it made. */
export function renderOnServer(
  anim: Animation,
  mode: DisplayMode,
  size: DisplaySize = DEFAULT_SIZE,
  timeoutMs = 8000,
): Promise<{ frames: Frame[]; texts: TextDraw[] }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource(canvasPath), {
      eval: true,
      env: {},
      workerData: { ...anim, ...size, mode },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Animation took too long to render'));
    }, timeoutMs);
    worker.once('message', (m: { frames?: Frame[]; texts?: TextDraw[]; error?: string }) => {
      clearTimeout(timer);
      worker.terminate();
      if (m.error || !m.frames) reject(new Error(m.error ?? 'No frames'));
      else resolve({ frames: m.frames, texts: m.texts ?? [] });
    });
    worker.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
