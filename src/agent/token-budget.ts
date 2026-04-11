// ---------------------------------------------------------------------------
// Token budget — context window math and conversation trimming
// ---------------------------------------------------------------------------

import type { Message } from "../api/client";

export const DEFAULT_CONTEXT_WINDOW = 200_000;
const SAFETY_BUFFER_TOKENS = 2_048;
const MIN_INPUT_BUDGET_TOKENS = 4_000;
const CONTEXT_TAIL_TO_KEEP = 8;

/**
 * Returns the context window size for a given model key, falling back to the default.
 *
 * @param modelKey - The model key to look up (e.g. `"claude-sonnet"`), or undefined for auto-routed calls.
 * @param modelContextWindows - Map of model key to context window size from the models API.
 * @returns The context window token count for the model, or DEFAULT_CONTEXT_WINDOW if unknown.
 */
export function resolveContextWindow(
  modelKey: string | undefined,
  modelContextWindows: Map<string, number>
): number {
  if (modelKey !== undefined && modelContextWindows.has(modelKey)) {
    return modelContextWindows.get(modelKey) ?? DEFAULT_CONTEXT_WINDOW;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Approximates token count from character count (4 chars per token).
 *
 * @param text - The string to estimate token count for.
 * @returns Estimated number of tokens.
 */
function estimateTokenCount(text: string): number {
  if (text.length === 0) { return 0; }
  return Math.ceil(text.length / 4);
}

/**
 * Estimates total token count for a full conversation array.
 *
 * @param messages - The conversation messages to estimate tokens for.
 * @returns Estimated total token count across all messages.
 */
export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokenCount(message.role);
    if (typeof message.content === "string") {
      total += estimateTokenCount(message.content);
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") {
        total += estimateTokenCount(block.text);
      } else if (block.type === "tool_use") {
        total += estimateTokenCount(block.name);
        total += estimateTokenCount(JSON.stringify(block.input));
      } else {
        total += estimateTokenCount(block.content);
      }
    }
  }
  return total;
}

/**
 * Returns the number of input tokens the conversation can use, after
 * reserving space for the system prompt, tools schema, and safety buffer.
 *
 * @param contextWindow - Total context window size in tokens for the model.
 * @param systemPrompt - The system prompt string (counted against the budget).
 * @param tools - The tools schema array (counted against the budget).
 * @returns Available input token budget for the conversation messages.
 */
export function computeInputTokenBudget(
  contextWindow: number,
  systemPrompt: string,
  tools: unknown
): number {
  const staticOverhead =
    estimateTokenCount(systemPrompt) + estimateTokenCount(JSON.stringify(tools));
  const rawBudget = contextWindow - SAFETY_BUFFER_TOKENS - staticOverhead;
  return Math.max(MIN_INPUT_BUDGET_TOKENS, rawBudget);
}

/**
 * Trims the oldest assistant/tool-result round-trips from the conversation
 * until it fits within the token budget. Mutates the array in place.
 *
 * @param conversation - The conversation array to trim (mutated in place).
 * @param inputBudget - The maximum number of input tokens allowed.
 * @returns Stats about how many messages were removed and token counts before/after.
 */
export function trimConversationToBudget(
  conversation: Message[],
  inputBudget: number
): { removed: number; tokensBefore: number; tokensAfter: number } {
  const tokensBefore = estimateMessagesTokens(conversation);
  let removed = 0;

  while (
    estimateMessagesTokens(conversation) > inputBudget &&
    conversation.length > 1 + CONTEXT_TAIL_TO_KEEP + 1
  ) {
    const roundStart = findOldestRemovableRoundStart(conversation);
    if (roundStart === -1) { break; }
    conversation.splice(roundStart, 2);
    removed += 2;
  }

  return { removed, tokensBefore, tokensAfter: estimateMessagesTokens(conversation) };
}

/**
 * Finds the index of the oldest assistant+tool-result pair that can be safely removed.
 *
 * @param conversation - The conversation array to search.
 * @returns Index of the oldest removable assistant message, or -1 if none found.
 */
function findOldestRemovableRoundStart(conversation: Message[]): number {
  const protectedTailStart = Math.max(1, conversation.length - CONTEXT_TAIL_TO_KEEP);
  for (let i = 1; i + 1 < protectedTailStart; i++) {
    const assistant = conversation[i];
    const user = conversation[i + 1];
    if (assistant.role !== "assistant" || user.role !== "user") { continue; }
    if (!messageHasToolUse(assistant) || !messageHasToolResult(user)) { continue; }
    return i;
  }
  return -1;
}

/**
 * Returns true if the message contains at least one tool_use content block.
 *
 * @param message - The message to inspect.
 * @returns True if the message has a tool_use block.
 */
function messageHasToolUse(message: Message): boolean {
  return Array.isArray(message.content) &&
    message.content.some((b) => b.type === "tool_use");
}

/**
 * Returns true if the message contains at least one tool_result content block.
 *
 * @param message - The message to inspect.
 * @returns True if the message has a tool_result block.
 */
function messageHasToolResult(message: Message): boolean {
  return Array.isArray(message.content) &&
    message.content.some((b) => b.type === "tool_result");
}
