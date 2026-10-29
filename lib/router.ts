import { anthropic } from '@ai-sdk/anthropic';
import { generateText, Output, stepCountIs } from 'ai';
import { deviceModel, routerModel } from './models';

// Before anything is drawn, a fast model sorts each screen prompt: something to draw goes
// straight to the frame generator; a question is answered first (with web search), and the
// frame generator gets a short visual brief of the answer instead.

export type Route = 'draw' | 'answer';

/** Where the screen is, from Vercel's IP lookup headers; empty fields elsewhere. */
export function screenPlace(req: Request) {
  const header = (name: string) => {
    const value = req.headers.get(name);
    return value ? decodeURIComponent(value) : undefined;
  };
  return {
    city: header('x-vercel-ip-city'),
    region: header('x-vercel-ip-country-region'),
    country: header('x-vercel-ip-country'),
    timezone: header('x-vercel-ip-timezone'),
  };
}

export type Place = ReturnType<typeof screenPlace>;

const placeText = (place: Place) => [place.city, place.region, place.country].filter(Boolean).join(', ') || 'unknown';

export async function routePrompt(prompt: string): Promise<Route> {
  const { output } = await generateText({
    model: routerModel,
    output: Output.choice({ options: ['draw', 'answer'] as Route[] }),
    system: `You sort requests for a small LED display that can show animations and short text.
"draw": the person describes something to show (a scene, a pattern, an effect, a word or message to display).
"answer": the person asks a question or wants information (time, date, facts, maths, weather, news, scores, definitions).`,
    prompt,
  });
  return output ?? 'draw';
}

/**
 * Answers a question, searching the web when it needs live information, and returns a short
 * brief of what to show, like "SUNNY 72°F, with a bright sun".
 */
export async function answerPrompt(prompt: string, now: string, place: Place) {
  const { text } = await generateText({
    model: deviceModel,
    system: `You answer questions for an LED display that is 64x32 pixels and fits about 10 characters per line.
Current date and time: ${now}. The display is in: ${placeText(place)}.
Search the web only when the answer needs live or recent information.
Reply in plain text (no markdown) with only a brief for the person who draws the display: the answer in at most a few words (exact numbers, units and names), then a short idea for a matching picture. Example: "SUNNY 72°F - a bright sun with a few rays".`,
    prompt,
    tools: {
      web_search: anthropic.tools.webSearch_20250305({
        maxUses: 3,
        userLocation: { type: 'approximate', city: place.city, region: place.region, country: place.country, timezone: place.timezone },
      }),
    },
    stopWhen: stepCountIs(4),
  });
  return text.trim();
}
