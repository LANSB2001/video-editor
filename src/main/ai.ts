import Anthropic from '@anthropic-ai/sdk';
import { AI_SYSTEM_PROMPT, APPLY_EDITS_SCHEMA, type AiAction } from '../engine';
import type { AiRequest, AiResponse } from '../shared/api';

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** Asks Claude to turn an edit instruction into editor actions. */
export async function runAi(apiKey: string, model: string, req: AiRequest): Promise<AiResponse> {
  const client = new Anthropic({ apiKey });
  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    // Simple, latency-sensitive translation task.
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: AI_SYSTEM_PROMPT,
    tools: [
      {
        name: 'apply_edits',
        description: 'Apply a list of edits to the open project. Call this exactly once per request.',
        input_schema: APPLY_EDITS_SCHEMA as unknown as Anthropic.Beta.BetaTool.InputSchema,
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Project:\n${JSON.stringify(req.context)}\n\nRequest: ${req.instruction}`,
      },
    ],
  } as Anthropic.Beta.MessageCreateParamsNonStreaming);

  if (response.stop_reason === 'refusal') {
    return { actions: [], reply: 'The assistant declined that request.' };
  }
  let text = '';
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'apply_edits') {
      const input = block.input as { reply?: unknown; actions?: unknown };
      const actions = Array.isArray(input.actions) ? (input.actions as AiAction[]) : [];
      return { actions, reply: typeof input.reply === 'string' ? input.reply : 'Done.' };
    }
    if (block.type === 'text') text += block.text;
  }
  return { actions: [], reply: text.trim() || 'I could not work out an edit for that.' };
}
