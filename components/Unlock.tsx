'use client';

import { useEffect, useRef, useState } from 'react';

/** The lock screen shown while the site needs a passcode; calls onUnlock with it once the server accepts it. */
export default function Unlock({ onUnlock }: { onUnlock: (code: string) => void }) {
  const [code, setCode] = useState('');
  const [show, setShow] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code || checking) return;
    setChecking(true);
    setError(null);
    try {
      const res = await fetch('/api/unlock', { method: 'POST', headers: { 'X-Site-Passcode': code } });
      if (res.ok) onUnlock(code);
      else {
        setError('That passcode isn’t right.');
        input.current?.select();
      }
    } catch {
      setError('Couldn’t reach the server. Try again.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="unlock">
      <form className="unlock-card" onSubmit={submit}>
        <div className="unlock-dots" aria-hidden>
          {Array.from({ length: 24 }, (_, i) => (
            <span key={i} style={{ animationDelay: `${(i % 8) * 0.12 + Math.floor(i / 8) * 0.2}s` }} />
          ))}
        </div>
        <h1>LED Matrix Studio</h1>
        <p className="muted">Enter the passcode to start drawing.</p>
        <div className="unlock-field">
          <input
            ref={input}
            type={show ? 'text' : 'password'}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Passcode"
            autoComplete="current-password"
            aria-label="Passcode"
          />
          <button type="button" className="unlock-eye" onClick={() => setShow((s) => !s)}>
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        <button type="submit" className="unlock-go" disabled={!code || checking}>
          {checking ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
