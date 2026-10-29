import type { DisplayMode, Frame } from './animation';

// The player's upload format (see firmware/player): "LMX1" header, then RGB565 pixels.
// Used for USB (lib/panelSerial.ts) and for the screens' server requests (app/api/device).

const MONO_ON: [number, number, number] = [255, 59, 47]; // same red as the simulator

const rgb565 = (r: number, g: number, b: number) => ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);

/** Packs frames in the player's upload format: "LMX1" header, then RGB565 pixels. */
export function encodeAnimation(frames: Frame[], fps: number, mode: DisplayMode): Uint8Array {
  const h = frames[0].length, w = frames[0][0].length;
  const length = frames.length * w * h * 2;
  const out = new Uint8Array(16 + length);
  const view = new DataView(out.buffer);
  out.set([0x4c, 0x4d, 0x58, 0x31]); // "LMX1"
  view.setUint8(4, w);
  view.setUint8(5, h);
  view.setUint8(6, Math.max(1, Math.min(60, Math.round(fps))));
  view.setUint16(8, frames.length, true);
  view.setUint32(12, length, true);
  let o = 16;
  for (const frame of frames)
    for (const row of frame)
      for (const v of row) {
        const c =
          v === 0 ? 0 : mode === 'rgb' ? rgb565((v >> 16) & 255, (v >> 8) & 255, v & 255) : rgb565(...MONO_ON);
        view.setUint16(o, c, true);
        o += 2;
      }
  return out;
}

