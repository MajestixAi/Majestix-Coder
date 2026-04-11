// ---------------------------------------------------------------------------
// Conversation compaction — summarises old turns so the loop never hits the
// context window hard limit by blindly dropping messages.
//
// When the conversation grows past COMPACT_THRESHOLD messages, a cheap LLM
// call produces a rolling summary of everything so far. The conversation is
// then rebuilt as:
//
//   [original task] → [summary injection] → [ack] → [...last COMPACT_TAIL messages]
//
// If the conversation grows again before the next compact, the existing summary
// is rolled forward — old context is never fully lost.
// ---------------------------------------------------------------------------

import type { MajestixClient, Message } from "../api/client";

/**
 * Fraction of the model's input token budget at which compaction fires.
 * 2/3 leaves headroom for the remainder of the current agent turn.
 */
export const COMPACT_BUDGET_FRACTION = 2 / 3;

/**
 * Maximum character length of the formatted conversation text sent to the
 * compaction model. Prevents overwhelming a cheap model with a massive payload
 * when the conversation contains many large file reads or tool outputs.
 * ~80K chars ≈ ~20K tokens — well within Nemotron-Nano's capacity.
 */
const MAX_COMPACT_INPUT_CHARS = 80_000;

const COMPACT_SYSTEM = `You are a conversation memory manager for an AI coding assistant.

Given the conversation history below, produce a concise summary that captures:
- The user's original task or goal
- Files read, edited, or created so far
- Commands run and their outcomes
- Key decisions, errors encountered, and how they were resolved
- Current state — what has been completed and what still needs to be done
- Any file paths, function names, or code details the agent will need next

Be concise (under 400 words). Focus on durable facts, not filler.
If a prior summary is provided, merge it with the new messages — do not lose earlier context.

Respond with ONLY the summary text. No JSON, no preamble, no headers.`;

/**
 * Format a conversation array as readable plain text for the summarisation prompt.
 *
 * @param conversation - The conversation messages to format.
 * @returns Plain-text representation of the conversation for the summarisation prompt.
 */
function formatConversationForSummary(conversation: Message[]): string {
  return conversation.map(msg => {
    const role = msg.role === "user" ? "User" : "Assistant";

    if (typeof msg.content === "string") {
      return `${role}: ${msg.content}`;
    }

    const parts = msg.content.map(block => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "tool_use") {
        const inputSnippet = JSON.stringify(block.input).slice(0, 300);
        return `[Tool call: ${block.name}(${inputSnippet})]`;
      }
      // tool_result
      return `[Tool result: ${block.content.slice(0, 300)}]`;
    }).filter(p => p.length > 0);

    return `${role}: ${parts.join("\n")}`;
  }).join("\n\n");
}

/**
 * Call the LLM to produce a rolling summary of the conversation.
 *
 * Uses auto-routing (model: null) so the harness picks the cheapest available
 * model — this is a background-quality call, not a user-facing response.
 * No tools, no thinking — just a plain summarisation pass.
 *
 * @param conversation - The full conversation to summarise.
 * @param existingSummary - A prior summary to roll forward, or null if this is the first compaction.
 * @param client - The MajestixClient instance used to make the LLM call.
 * @param signal - AbortSignal for cancellation.
 * @returns Summary string, or null if the call fails (loop continues without compacting).
 */
export async function compactConversation(
  conversation: Message[],
  existingSummary: string | null,
  client: MajestixClient,
  signal: AbortSignal,
): Promise<string | null> {
  let historyText = formatConversationForSummary(conversation);

  // Cap the payload so a cheap compaction model doesn't choke on massive
  // conversations (e.g. 30+ file reads). Keep the tail — recent context
  // matters more than early messages which are already in existingSummary.
  if (historyText.length > MAX_COMPACT_INPUT_CHARS) {
    historyText = "[...earlier messages truncated...]\n\n" + historyText.slice(-MAX_COMPACT_INPUT_CHARS);
  }

  const userContent = existingSummary !== null && existingSummary.length > 0
    ? `EXISTING SUMMARY (from previous compaction):\n${existingSummary}\n\nNEW MESSAGES TO INCORPORATE:\n${historyText}`
    : historyText;

  let summary = "";

  // 30 s timeout — compaction is best-effort, never worth blocking longer.
  const timeoutController = new AbortController();
  const timer = setTimeout(() => { timeoutController.abort(); }, 30_000);
  const onParentAbort = (): void => { timeoutController.abort(); };
  signal.addEventListener("abort", onParentAbort, { once: true });

  try {
    for await (const event of client.codeStream(
      {
        messages: [{ role: "user", content: userContent }],
        system: COMPACT_SYSTEM,
        tools: [],
        model: null,         // auto-route to cheapest available
        enable_thinking: false,
        temperature: 0.2,
      },
      timeoutController.signal,
    )) {
      if (timeoutController.signal.aborted) { break; }
      if (event.type === "text") {
        summary += event.content;
      } else if (event.type === "done" || event.type === "error") {
        break;
      }
    }
  } catch {
    // Compaction is best-effort — if it fails the loop continues without it
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onParentAbort);
  }

  const trimmed = summary.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build the two-message compact frame that becomes the new model context.
 *
 * Shape: [summaryMsg (user), ackMsg (assistant)]
 *
 * Only these two messages are sent to the model after compaction — no tail.
 * Everything that happened before is captured in the summary text.
 * New messages accumulate after this frame as the loop continues.
 *
 * The full pre-compaction conversation (plus this frame appended) is kept on
 * disk so the user's chat history is never destroyed.
 *
 * @param messageCount - Number of messages being compacted (for the summary label).
 * @param summary - The summary produced by compactConversation().
 * @returns The two-message compact frame [summaryMsg, ackMsg].
 */
export function buildCompactFrame(
  messageCount: number,
  summary: string,
): Message[] {
  const summaryMessage: Message = {
    role: "user",
    content: `[CONVERSATION SUMMARY — prior context, ${String(messageCount)} messages compacted]\n\n${summary}`,
  };

  const ackMessage: Message = {
    role: "assistant",
    content: "Understood — I have the full context from the summary above and will continue from where we left off.",
  };

  return [summaryMessage, ackMessage];
}
