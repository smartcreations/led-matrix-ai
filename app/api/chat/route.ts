import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  tool,
  type UIMessage,
} from 'ai';
import { HEIGHT, WIDTH, type DisplayMode } from '@/lib/animation';
import { chatModel } from '@/lib/models';
import { animationSchema, systemPrompt } from '@/lib/prompt';

export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages, mode = 'mono' }: { messages: UIMessage[]; mode?: DisplayMode } = await req.json();

  const result = streamText({
    model: chatModel,
    system: systemPrompt(mode === 'rgb' ? 'rgb' : 'mono'),
    messages: await convertToModelMessages(messages),
    tools: {
      createAnimation: tool({
        description: `Show an animation on the ${WIDTH}x${HEIGHT} ${mode === 'rgb' ? 'full-color' : 'single-color'} LED display.`,
        inputSchema: animationSchema,
        // Rendering happens in the browser; the server just acknowledges.
        execute: async ({ title }) => ({ shown: title }),
      }),
    },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
