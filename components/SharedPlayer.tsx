'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import LedMatrix from '@/components/LedMatrix';
import { renderAnimation, type Frame } from '@/lib/animation';
import type { StoredShare } from '@/lib/shares';

/** Plays a shared animation in the browser; no chat and no AI calls. */
export default function SharedPlayer({ share }: { share: StoredShare }) {
  const blank: Frame = Array.from({ length: share.height }, () => new Array(share.width).fill(0));
  const [frames, setFrames] = useState<Frame[]>([blank]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    renderAnimation(share, share.mode, { width: share.width, height: share.height })
      .then((f) => setFrames(f))
      .catch((e: Error) => setError(e.message));
  }, [share]);

  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % frames.length), 1000 / share.fps);
    return () => clearInterval(id);
  }, [playing, frames.length, share.fps]);

  return (
    <main className="share">
      <section className="panel share-card">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <strong>{share.title}</strong>
          <span className="muted">
            {share.width}×{share.height} {share.mode === 'rgb' ? 'RGB' : 'bicolor'} · {share.fps} fps
          </span>
        </div>
        <LedMatrix frame={frames[index] ?? blank} mode={share.mode} />
        {error && <div className="error">This animation couldn’t be played: {error}</div>}
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="toolbar">
            <button onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause' : 'Play'}</button>
            <button
              onClick={() => {
                setIndex(0);
                setPlaying(true);
              }}
            >
              Replay
            </button>
          </div>
          <Link href="/" className="button-link">
            Make your own
          </Link>
        </div>
      </section>
    </main>
  );
}
