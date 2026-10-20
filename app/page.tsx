'use client';

import { useChat } from '@ai-sdk/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LedMatrix from '@/components/LedMatrix';
import { HEIGHT, WIDTH, renderAnimation, type Animation, type Frame } from '@/lib/animation';
import { DEMOS } from '@/lib/demos';

const BLANK: Frame = Array.from({ length: HEIGHT }, () => new Array(WIDTH).fill(0));

type ToolPart = {
  type: 'tool-createAnimation';
  toolCallId: string;
  state: string;
  input?: Animation;
};

export default function Home() {
  const [anim, setAnim] = useState<Animation>(DEMOS[0]);
  const [code, setCode] = useState(DEMOS[0].code);
  const [frames, setFrames] = useState<Frame[]>([BLANK]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const applied = useRef(new Set<string>());
  const { messages, sendMessage, status, error: chatError } = useChat();

  const load = useCallback(async (next: Animation) => {
    setAnim(next);
    setCode(next.code);
    try {
      const rendered = await renderAnimation(next);
      setFrames(rendered);
      setIndex(0);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load(DEMOS[0]);
  }, [load]);

  // Pick up animations the AI creates.
  useEffect(() => {
    for (const m of messages) {
      for (const part of m.parts as unknown as ToolPart[]) {
        if (part.type !== 'tool-createAnimation' || !part.input) continue;
        if (part.state !== 'input-available' && part.state !== 'output-available') continue;
        if (applied.current.has(part.toolCallId)) continue;
        applied.current.add(part.toolCallId);
        load(part.input);
      }
    }
  }, [messages, load]);

  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % frames.length), 1000 / anim.fps);
    return () => clearInterval(id);
  }, [playing, frames.length, anim.fps]);

  const frame = frames[index] ?? BLANK;
  const litCount = useMemo(() => frame.reduce((n, row) => n + row.reduce((a, b) => a + b, 0), 0), [frame]);

  const copyFrame = () => navigator.clipboard.writeText(JSON.stringify(frame));
  const copyAll = () => navigator.clipboard.writeText(JSON.stringify(frames));

  const busy = status === 'submitted' || status === 'streaming';

  return (
    <main className="app">
      <section className="panel stage">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <strong>{anim.title}</strong>
          <span className="muted">
            {WIDTH}×{HEIGHT} · frame {index + 1}/{frames.length} · {anim.fps} fps · {litCount} LEDs on
          </span>
        </div>

        <div style={{ width: '100%', maxWidth: 720, alignSelf: 'center' }}>
          <LedMatrix frame={frame} />
        </div>

        <div className="toolbar">
          <button onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause' : 'Play'}</button>
          <button disabled={playing} onClick={() => setIndex((i) => (i - 1 + frames.length) % frames.length)}>
            ◀ Step
          </button>
          <button disabled={playing} onClick={() => setIndex((i) => (i + 1) % frames.length)}>
            Step ▶
          </button>
          <select
            value=""
            onChange={(e) => {
              const demo = DEMOS[Number(e.target.value)];
              if (demo) load(demo);
            }}
          >
            <option value="">Load a demo…</option>
            {DEMOS.map((d, i) => (
              <option key={d.title} value={i}>
                {d.title}
              </option>
            ))}
          </select>
          <button onClick={copyFrame}>Copy frame (0/1 JSON)</button>
          <button onClick={copyAll}>Copy all frames</button>
        </div>

        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <span className="muted">
            draw(ctx, t, p, w, h, setPixel, text, textWidth) — edit and press Run
          </span>
          <button onClick={() => load({ ...anim, code })}>Run</button>
        </div>
        <textarea className="code" value={code} spellCheck={false} onChange={(e) => setCode(e.target.value)} />
        {error && <div className="error">{error}</div>}
      </section>

      <section className="panel chat">
        <div className="messages">
          {messages.length === 0 && (
            <p className="muted">
              Describe an animation, like “a heartbeat line that pulses across the screen” or “fireworks bursting
              left to right”. Then ask for changes.
            </p>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.parts.map((part, i) => {
                if (part.type === 'text') return <span key={i}>{part.text}</span>;
                if (part.type === 'tool-createAnimation') {
                  const p = part as unknown as ToolPart;
                  return (
                    <div key={i}>
                      <span className="chip">
                        {p.state === 'input-streaming' ? 'Writing animation…' : `▶ ${p.input?.title ?? 'Animation'}`}
                      </span>
                    </div>
                  );
                }
                return null;
              })}
            </div>
          ))}
          {busy && <span className="muted">Thinking…</span>}
          {chatError && (
            <div className="error">Chat failed: {chatError.message} Check the server log; is ANTHROPIC_API_KEY (or AI_GATEWAY_API_KEY) set in .env.local?</div>
          )}
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim()) return;
            sendMessage({ text: input });
            setInput('');
          }}
        >
          <input value={input} placeholder="Describe an animation…" onChange={(e) => setInput(e.target.value)} />
          <button type="submit" disabled={busy}>
            Send
          </button>
        </form>
      </section>
    </main>
  );
}
