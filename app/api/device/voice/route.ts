import { createGateway, experimental_transcribe as transcribe } from 'ai';
import { animationResponse, deviceAuthorized } from '@/lib/deviceAnimation';

export const maxDuration = 120;

// Speech to text through the Vercel AI Gateway: on Vercel it signs in by itself, elsewhere it
// needs AI_GATEWAY_API_KEY. Override the model with TRANSCRIBE_MODEL.
const transcriber = createGateway().transcriptionModel(process.env.TRANSCRIBE_MODEL ?? 'openai/gpt-4o-mini-transcribe');

const MAX_AUDIO = 2 * 1024 * 1024; // about a minute of 16 kHz speech

/**
 * For LED screens: POST what was said after the wake word, as a WAV file, with
 * "Authorization: Bearer <DEVICE_KEY>". Replies like /api/device/animation, plus the
 * transcribed prompt in the X-Prompt header. 422 when no words were heard.
 */
export async function POST(req: Request) {
  if (!deviceAuthorized(req)) return new Response('Unauthorized', { status: 401 });

  const audio = new Uint8Array(await req.arrayBuffer());
  if (audio.length < 1000 || audio.length > MAX_AUDIO) return new Response('Bad audio size', { status: 400 });

  const { text } = await transcribe({ model: transcriber, audio });
  const prompt = text.trim().slice(0, 500);
  console.log(`[voice] heard: ${JSON.stringify(prompt)}`);
  if (!/[a-z0-9]/i.test(prompt)) return new Response("Didn't catch any words", { status: 422 });
  return animationResponse(req, prompt, 'rgb', { 'X-Prompt': encodeURIComponent(prompt) });
}
