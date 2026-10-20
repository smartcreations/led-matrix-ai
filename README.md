# LED Matrix Studio

Describe an animation in the chat; the AI writes a tiny drawing program, the browser renders it into frames of 0/1 and shows them on a virtual 60×32 LED matrix.

## Run it

```bash
npm install
echo "ANTHROPIC_API_KEY=your-key" > .env.local    # or AI_GATEWAY_API_KEY=... for Vercel AI Gateway
npm run dev                                         # http://localhost:3000
```

The demos and the code editor work without a key; only the chat needs one.
To use another model (Gemini, for example) set `LED_MODEL` in `.env.local` to its AI Gateway model id (with `AI_GATEWAY_API_KEY`). With `ANTHROPIC_API_KEY`, `LED_MODEL` is an Anthropic model id; the default is `claude-sonnet-5-5`.

## How it fits together

- `components/LedMatrix.tsx`: the display. Input is `frame: number[][]`, 32 rows × 60 columns of 0/1.
- `lib/animation.ts`: `renderAnimation()` runs the generated `draw(...)` code in a Web Worker on a 60×32 canvas, thresholds every pixel and returns `Frame[]`.
- `app/api/chat/route.ts`: AI SDK route; the model answers by calling the `createAnimation` tool with `{ title, fps, durationMs, code }`.
- `app/page.tsx`: chat, player, code editor, and "Copy frame" buttons that give you the raw 0/1 JSON (the same data the Arduino will get later).
