import { anthropic } from '@ai-sdk/anthropic';

// With ANTHROPIC_API_KEY set, call Anthropic directly; otherwise use the AI Gateway
// (AI_GATEWAY_API_KEY), where any gateway model id works, including Google Gemini models.
const direct = Boolean(process.env.ANTHROPIC_API_KEY);

/** Writes the animations. Override with LED_MODEL. */
export const chatModel = direct
  ? anthropic(process.env.LED_MODEL ?? 'claude-sonnet-5-5')
  : (process.env.LED_MODEL ?? 'anthropic/claude-sonnet-5.5');

/** Small, fast model for the starter suggestions. Override with SUGGESTIONS_MODEL. */
export const suggestModel = direct
  ? anthropic(process.env.SUGGESTIONS_MODEL ?? 'claude-haiku-5-5')
  : (process.env.SUGGESTIONS_MODEL ?? 'anthropic/claude-haiku-5.5');
