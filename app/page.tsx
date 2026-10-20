'use client';

import { useChat } from '@ai-sdk/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LedMatrix from '@/components/LedMatrix';
import { HEIGHT, WIDTH, renderAnimation, type Animation, type DisplayMode, type Frame } from '@/lib/animation';
import { DEMOS } from '@/lib/demos';

const BLANK: Frame = Array.from({ length: HEIGHT }, () => new Array(WIDTH).fill(0));
const MODE_KEY = 'led-display-mode';
const LAST_DEMO_KEY = 'led-last-demo';

/** A random demo that suits the saved display type, avoiding the one shown last time. */
function randomDemo(): Animation {
  let rgb = false;
  let last: string | null = null;
  try {
    rgb = localStorage.getItem(MODE_KEY) === 'rgb';
    last = localStorage.getItem(LAST_DEMO_KEY);
  } catch {}
  const fits = DEMOS.filter((d) => rgb || !d.rgbOnly);
  const fresh = fits.filter((d) => d.title !== last);
  const pool = fresh.length ? fresh : fits;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  try {
    localStorage.setItem(LAST_DEMO_KEY, pick.title);
  } catch {}
  return pick;
}

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
  const [mode, setMode] = useState<DisplayMode>('mono');
  const applied = useRef(new Set<string>());
  const { messages, sendMessage, status, error: chatError } = useChat();
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [share, setShare] = useState<{ state: 'idle' | 'saving' | 'done' | 'error'; text?: string; copied?: boolean }>({
    state: 'idle',
  });

  // Restore the saved display type.
  useEffect(() => {
    try {
      if (localStorage.getItem(MODE_KEY) === 'rgb') setMode('rgb');
    } catch {}
  }, []);

  const changeMode = (next: DisplayMode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {}
  };

  useEffect(() => {
    let cancelled = false;
    setSuggestions([]);
    fetch(`/api/suggestions?mode=${mode}`)
      .then((r) => r.json())
      .then((d: { suggestions?: string[] }) => !cancelled && setSuggestions(d.suggestions ?? []))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const load = useCallback(async (next: Animation) => {
    setAnim(next);
    setCode(next.code);
    try {
      const rendered = await renderAnimation(next, mode);
      setFrames(rendered);
      setIndex(0);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [mode]);

  // Start with a random demo, and re-render the current animation whenever the display type changes.
  const current = useRef(anim);
  const started = useRef(false);
  current.current = anim;
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      current.current = randomDemo();
    }
    load(current.current);
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
  const litCount = useMemo(() => frame.reduce((n, row) => n + row.filter((v) => v !== 0).length, 0), [frame]);
  const send = (text: string) => sendMessage({ text }, { body: { mode } });

  // Saves the animation recipe (not the chat) and copies a public link to it.
  const createShare = async () => {
    setShare({ state: 'saving' });
    try {
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: anim.title, code: anim.code, fps: anim.fps, durationMs: anim.durationMs, mode, width: WIDTH, height: HEIGHT }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Saving the share link failed.');
      let copied = false;
      try {
        await navigator.clipboard.writeText(data.url);
        copied = true;
      } catch {}
      setShare({ state: 'done', text: data.url, copied });
    } catch (e) {
      setShare({ state: 'error', text: (e as Error).message });
    }
  };

  // A new animation needs a new link.
  useEffect(() => setShare({ state: 'idle' }), [anim, mode]);

  const copyFrame = () => navigator.clipboard.writeText(JSON.stringify(frame));
  const copyAll = () => navigator.clipboard.writeText(JSON.stringify(frames));

  const busy = status === 'submitted' || status === 'streaming';

  return (
    <main className="app">
      <section className="panel stage">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <strong>{anim.title}</strong>
          <span className="muted">
            {WIDTH}×{HEIGHT} {mode === 'rgb' ? 'RGB' : 'bicolor'} · frame {index + 1}/{frames.length} · {anim.fps} fps · {litCount} LEDs on
          </span>
        </div>

        <div style={{ width: '100%', maxWidth: 720, alignSelf: 'center' }}>
          <LedMatrix frame={frame} mode={mode} />
        </div>

        <div className="toolbar">
          <select id="display-type" aria-label="Display type" value={mode} onChange={(e) => changeMode(e.target.value as DisplayMode)}>
            <option value="mono">Bicolor (current)</option>
            <option value="rgb">Multicolor (RGB)</option>
          </select>
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
          <button onClick={copyFrame}>Copy frame ({mode === 'rgb' ? '0xRRGGBB' : '0/1'} JSON)</button>
          <button onClick={copyAll}>Copy all frames</button>
          <button onClick={createShare} disabled={share.state === 'saving'}>
            {share.state === 'saving' ? 'Creating link…' : 'Share link'}
          </button>
        </div>
        {share.state === 'done' && (
          <div className="share-link">
            <input id="share-url" readOnly value={share.text} onFocus={(e) => e.target.select()} aria-label="Share link" />
            <button onClick={() => navigator.clipboard.writeText(share.text ?? '').then(() => setShare({ ...share, copied: true }))}>
              {share.copied ? 'Copied' : 'Copy'}
            </button>
            <a className="button-link" href={share.text} target="_blank" rel="noreferrer">
              Open
            </a>
          </div>
        )}
        {share.state === 'error' && <div className="error">{share.text}</div>}

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
            send(input);
            setInput('');
          }}
        >
          <input value={input} placeholder="Describe an animation…" onChange={(e) => setInput(e.target.value)} />
          <button type="submit" disabled={busy}>
            Send
          </button>
        </form>
        {messages.length === 0 && (
          <div className="suggestions">
            {suggestions.length === 0 && <span className="muted">Thinking of ideas…</span>}
            {suggestions.map((s) => (
              <button key={s} type="button" className="suggestion" disabled={busy} onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
