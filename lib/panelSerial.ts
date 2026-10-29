import type { DisplayMode, Frame } from './animation';
import { encodeAnimation } from './lmx';

export { encodeAnimation };

// Minimal Web Serial types (Chrome and Edge only; not in TypeScript's DOM library).
type SerialPortLike = {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
};
type SerialLike = { requestPort(options?: { filters: { usbVendorId: number }[] }): Promise<SerialPortLike> };

const ESPRESSIF_USB_VENDOR = 0x303a;
export const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

let port: SerialPortLike | null = null;

/** Sends an animation to the panel over USB. Asks the user to pick the board the first time. */
export async function sendToPanel(frames: Frame[], fps: number, mode: DisplayMode): Promise<string> {
  const serial = (navigator as unknown as { serial: SerialLike }).serial;
  if (!port) {
    const picked = await serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_USB_VENDOR }] });
    await picked.open({ baudRate: 115200 });
    port = picked;
  }
  const data = encodeAnimation(frames, fps, mode);
  const writer = port.writable!.getWriter();
  const reader = port.readable!.getReader();
  const replies = new ReplyReader(reader);
  try {
    // Header, then pixels in chunks: the board acknowledges each one (see firmware/player).
    await writer.write(data.subarray(0, HEADER));
    await replies.waitForLine('GO', 3000);
    for (let i = HEADER; i < data.length; i += CHUNK) {
      await writer.write(data.subarray(i, Math.min(i + CHUNK, data.length)));
      await replies.waitForAck(3000);
    }
    return await replies.waitForLine('OK', 3000);
  } catch (e) {
    if (e instanceof PanelError) throw e;
    // The board was unplugged or reset: forget the port so the next send reconnects.
    reader.releaseLock();
    writer.releaseLock();
    await port.close().catch(() => {});
    port = null;
    throw new Error('Lost the connection to the panel. Check the USB cable and try again.');
  } finally {
    if (port) {
      reader.releaseLock();
      writer.releaseLock();
    }
  }
}

const HEADER = 16;
const CHUNK = 4096; // keep in sync with CHUNK in firmware/player/player.ino

class PanelError extends Error {}

/** Reads the board's replies: "+" acknowledgements and whole text lines. */
class ReplyReader {
  private text = '';
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  private async more(deadline: number) {
    const left = deadline - Date.now();
    if (left <= 0) throw new PanelError('The panel stopped answering. Unplug and reconnect the USB cable, then try again.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PanelError('The panel stopped answering. Unplug and reconnect the USB cable, then try again.')),
        left,
      );
    });
    try {
      const { value, done } = await Promise.race([this.reader.read(), timeout]);
      if (done) throw new Error('closed');
      this.text += new TextDecoder().decode(value);
    } finally {
      clearTimeout(timer);
    }
  }

  private takeError() {
    const m = this.text.match(/ERR ([^\r\n]*)/);
    if (m) throw new PanelError(`The panel refused it: ${m[1]}`);
  }

  async waitForAck(timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.takeError();
      const i = this.text.indexOf('+');
      if (i >= 0) {
        this.text = this.text.slice(i + 1);
        return;
      }
      await this.more(deadline);
    }
  }

  async waitForLine(prefix: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.takeError();
      const m = this.text.match(new RegExp(`${prefix}[^\r\n]*\r?\n`));
      if (m) {
        this.text = this.text.slice(m.index! + m[0].length);
        return m[0].trim();
      }
      await this.more(deadline);
    }
  }
}
