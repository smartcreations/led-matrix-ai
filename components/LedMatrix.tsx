'use client';

import { useEffect, useRef } from 'react';

type Props = {
  /** Rows of values: 0/1 in mono mode, packed 0xRRGGBB in rgb mode. Every row should have the same length. */
  frame: number[][];
  mode?: 'mono' | 'rgb';
  dotSize?: number;
  gap?: number;
  onColor?: string;
  offColor?: string;
};

/** Draws a 2D array of LED values as a dot-matrix LED panel. */
export default function LedMatrix({
  frame,
  mode = 'mono',
  dotSize = 6,
  gap = 2,
  onColor = '#ff3b2f',
  offColor,
}: Props) {
  const off = offColor ?? (mode === 'rgb' ? '#1c1c1c' : '#2a0d0b');
  const ref = useRef<HTMLCanvasElement>(null);
  const rows = frame.length;
  const cols = frame[0]?.length ?? 0;
  const pitch = dotSize + gap;

  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#0b0b0b';
    ctx.fillRect(0, 0, cols * pitch + gap, rows * pitch + gap);
    const r = dotSize / 2;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const v = frame[y][x];
        ctx.fillStyle = !v ? off : mode === 'rgb' ? `#${v.toString(16).padStart(6, '0')}` : onColor;
        ctx.beginPath();
        ctx.arc(gap + x * pitch + r, gap + y * pitch + r, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [frame, mode, rows, cols, pitch, dotSize, gap, onColor, off]);

  return (
    <canvas
      ref={ref}
      width={cols * pitch + gap}
      height={rows * pitch + gap}
      style={{ width: '100%', height: 'auto', borderRadius: 6, display: 'block' }}
    />
  );
}
