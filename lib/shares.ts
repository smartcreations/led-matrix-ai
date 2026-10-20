import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { get, put } from '@vercel/blob';
import { z } from 'zod';

/** What a share link stores: the animation recipe, not its frames and not the chat. */
export const ShareSpec = z.object({
  title: z.string().trim().min(1).max(80),
  code: z.string().min(1).max(20_000),
  fps: z.number().int().min(1).max(60),
  durationMs: z.number().int().min(100).max(20_000),
  mode: z.enum(['mono', 'rgb']),
  width: z.number().int().min(8).max(256),
  height: z.number().int().min(8).max(256),
});
export type ShareSpec = z.infer<typeof ShareSpec>;
export type StoredShare = ShareSpec & { createdAt: string };

const ID = /^[A-Za-z0-9]{8}$/;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const newId = () => Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');

// Vercel Blob when BLOB_READ_WRITE_TOKEN is set; otherwise JSON files in .shares/ for local dev.
const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const localDir = path.join(process.cwd(), '.shares');

export async function saveShare(spec: ShareSpec): Promise<string> {
  const id = newId();
  const body = JSON.stringify({ ...spec, createdAt: new Date().toISOString() } satisfies StoredShare);
  if (useBlob()) {
    await put(`shares/${id}.json`, body, { access: 'public', contentType: 'application/json' });
  } else {
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(localDir, `${id}.json`), body);
  }
  return id;
}

export async function loadShare(id: string): Promise<StoredShare | null> {
  if (!ID.test(id)) return null;
  try {
    let text: string;
    if (useBlob()) {
      const res = await get(`shares/${id}.json`, { access: 'public' });
      if (!res || res.statusCode !== 200) return null;
      text = await new Response(res.stream).text();
    } else {
      text = await readFile(path.join(localDir, `${id}.json`), 'utf8');
    }
    const data = JSON.parse(text);
    const spec = ShareSpec.parse(data);
    return { ...spec, createdAt: String(data.createdAt ?? '') };
  } catch {
    return null;
  }
}
