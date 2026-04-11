import * as vscode from "vscode";

import {
  ContentBlock,
  MajestixClient,
  Message,
} from "../api/client";
import {
  getToolDefinitions,
  getToolHandler,
  getToolNames,
  resolveToolName,
} from "../tools/registry";
import { clearAllBackups, revertFile } from "../tools/file-backup";
import { resolveWorkspacePath } from "../util/path-safety";
import type { ToolContext } from "../tools/types";
import { trackEvent } from "../util/telemetry";
import { ErrorTracker } from "./error-tracker";
import {
  buildSystemPrompt,
  getEnvironmentDetails,
  loadProjectRules,
} from "./system-prompt";
import { processThinkBuffer } from "./think-parser";
import {
  resolveContextWindow,
  computeInputTokenBudget,
  estimateMessagesTokens,
  trimConversationToBudget,
} from "./token-budget";
import {
  COMPACT_BUDGET_FRACTION,
  compactConversation,
  buildCompactFrame,
} from "./compact";
import {
  formatToolDescription,
  computeFileDiffSummary,
  normalizeAliasedInput,
} from "./tool-utils";

const DEFAULT_MAX_ITERATIONS = 50;
const MAX_TRANSIENT_RETRIES = 3;

/**
 * Hard cap on any single tool result content. Prevents unbounded output
 * (recursive grep, massive file reads, runaway commands) from bloating the
 * conversation, session file, and compaction input. Keeps head + tail so
 * the model sees the beginning and end of the output.
 */
const MAX_TOOL_RESULT_CHARS = 30_000;
const TOOL_RESULT_HEAD = 12_000;
const TOOL_RESULT_TAIL = 12_000;

/**
 * Returns true if the error message indicates a transient failure that can be retried.
 *
 * @param message - The error message string to classify.
 * @returns True if the error is transient and worth retrying.
 */
function isTransientError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("connection lost") ||
    lower.includes("stream ended unexpectedly") ||
    lower.includes("service unavailable") ||
    lower.includes("503") ||
    lower.includes("500") ||
    lower.includes("502") ||
    lower.includes("504") ||
    lower.includes("model experienced") ||
    lower.includes("internal server error") ||
    lower.includes("gateway") ||
    lower.includes("timeout") ||
    lower.includes("econnreset") ||
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("aborted") && !lower.includes("cancelled by user")
  );
}

/**
 * Returns true if the error message indicates a non-recoverable failure that should abort the loop.
 *
 * @param message - The error message string to classify.
 * @returns True if the error is non-recoverable and the loop should stop.
 */
function isNonRecoverableError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("invalid api key") ||
    lower.includes("insufficient credits") ||
    lower.includes("no api key") ||
    lower.includes("context is too large") ||
    lower.includes("cancelled by user") ||
    lower.includes("no workspace folder")
  );
}

/**
 * Events emitted by the agent loop for the UI to render.
 */
export type AgentEvent =
  | { type: "thinking" }
  | { type: "thinking_content"; content: string }
  | { type: "thinking_done" }
  | { type: "text"; content: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; content: string; is_error?: boolean }
  | { type: "file_edited"; path: string; op: "write" | "edit" | "patch" }
  | { type: "completion"; result: string; command?: string }
  | { type: "credits"; credits_used: number; model: string }
  | { type: "error"; message: string; conversation?: Message[] }
  | { type: "done"; total_credits: number; iterations: number; conversation: Message[]; compact_summary: string | null };

export interface AgentOptions {
  mode: string;
  model?: string;
  client: MajestixClient;
  postMessage: (msg: unknown) => void;
  requestApproval: (toolName: string, description: string, detail?: string) => Promise<boolean>;
  signal: AbortSignal;
  /** Pre-existing conversation to resume from. New user message is appended after these. */
  initialMessages?: Message[];
  /** Pre-loaded model context windows (from extension startup). Skips a getModels() round-trip. */
  cachedModelContextWindows?: Map<string, number>;
  /** Enable extended thinking/reasoning. */
  enableThinking?: boolean;
  /** Rolling compact summary carried forward from a prior session, if any. */
  compactSummary?: string | null;
}

/**
 * Run the agentic loop: send a task to the LLM, execute tools, repeat until done.
 *
 * SSE events are routed into two completely separate paths:
 *   THINKING PATH  — thinking/thinking_done events + <think>-tagged text segments
 *                    → yield thinking_content/thinking_done only, never touch tool state
 *   OUTPUT PATH    — text segments outside <think> + tool_use events
 *                    → accumulate into currentText / assistantBlocks for tool execution
 *
 * The two paths share no state. Thinking content can never trigger tool execution.
 *
 * @param task - The user's task string to execute.
 * @param options - Runtime options including client, mode, model, signal, and callbacks.
 */
export async function* runAgentLoop(
  task: string,
  options: AgentOptions
): AsyncGenerator<AgentEvent> {
  const { mode, model, client, postMessage, requestApproval, signal } = options;

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders === undefined) {
    yield { type: "error", message: "No workspace folder open" };
    return;
  }
  const workspaceRoot = workspaceFolders[0].uri;

  const toolContext: ToolContext = {
    workspaceRoot,
    postMessage,
    requestApproval,
    signal,
  };

  const envDetails = await getEnvironmentDetails();
  const projectRules = await loadProjectRules();
  const systemPrompt = buildSystemPrompt(mode, envDetails, projectRules);
  const tools = getToolDefinitions(mode);

  const modelContextWindows: Map<string, number> = options.cachedModelContextWindows ?? new Map<string, number>();
  if (options.cachedModelContextWindows === undefined) {
    try {
      const modelData = await client.getModels();
      for (const modelInfo of modelData.models) {
        if (modelInfo.context_window > 0) {
          modelContextWindows.set(modelInfo.key, modelInfo.context_window);
        }
      }
    } catch (err: unknown) {
      trackEvent("agent.models.fetch_error", {
        message: String(err instanceof Error ? err.message : err).slice(0, 200),
      });
    }
  }

  let activeModelKey = model;

  // Full history — every message ever sent/received. Appended to but never
  // truncated. Saved to disk so the user keeps a complete chat record.
  const conversation: Message[] = options.initialMessages !== undefined
    ? [...options.initialMessages, { role: "user", content: task }]
    : [{ role: "user", content: task }];

  // Model context — what actually gets sent to the LLM each iteration.
  // If a compact summary exists from a prior session, start from just the
  // summary frame + new user message. Otherwise take only the last
  // MAX_RESUME_MESSAGES to avoid flooding the model with the full session
  // (a 100+ message session with file reads can be 700K+ chars).
  const MAX_RESUME_MESSAGES = 20;
  const priorSummary = options.compactSummary ?? null;
  let modelMessages: Message[];
  if (priorSummary !== null && priorSummary.length > 0) {
    // Resume from compact summary — model sees summary + new message only
    const frame = buildCompactFrame(conversation.length - 1, priorSummary);
    modelMessages = [...frame, { role: "user", content: task }];
  } else if (options.initialMessages !== undefined && options.initialMessages.length > MAX_RESUME_MESSAGES) {
    // No summary but long history — take only the tail
    const tail = options.initialMessages.slice(-MAX_RESUME_MESSAGES);
    modelMessages = [...tail, { role: "user", content: task }];
  } else {
    modelMessages = [...conversation];
  }

  const maxIterations = vscode.workspace.getConfiguration("majestix").get<number>("maxIterations", DEFAULT_MAX_ITERATIONS);
  const costWarningThreshold = vscode.workspace.getConfiguration("majestix").get<number>("costWarningThreshold", 100);

  let totalCredits = 0;
  let iteration = 0;
  let completed = false;
  let transientRetries = 0;
  // Separate from transientRetries — does NOT reset per iteration.
  // transientRetries resets after every successful SSE stream, so using it
  // for empty-response retries caused an infinite loop when the model kept
  // producing only thinking content with no actual output.
  let emptyResponseRetries = 0;
  // Rolling compact summary — seeded from prior session if available, then
  // rolled forward each time compaction fires within this loop run.
  let compactSummary: string | null = options.compactSummary ?? null;
  const errorTracker = new ErrorTracker();

  while (iteration < maxIterations && !signal.aborted) {
    // Rate-limit: 1-second gap prevents back-to-back calls in auto-approve mode
    // from flooding providers and triggering 429s. Racing against the abort event
    // lets the stop button take effect immediately during the delay.
    if (iteration > 0) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 1000);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    iteration++;
    const iterationStart = Date.now();
    trackEvent("agent.iteration.start", { mode, iteration });
    yield { type: "thinking" };

    // --- Token budget for this iteration (used by both compaction and trim fallback) ---
    const contextWindow = resolveContextWindow(activeModelKey, modelContextWindows);
    const inputBudget = computeInputTokenBudget(contextWindow, systemPrompt, tools);

    // --- Compact only on the FIRST iteration (user just pressed Send) ---
    // Never mid-task: compaction is an LLM call that blocks the loop. Running it
    // between tool-use iterations would stall the agent and freeze the stop button.
    // The user's Send action is the natural place — they expect a brief pause.
    if (iteration === 1) {
      const modelTokens = estimateMessagesTokens(modelMessages);
      if (modelTokens >= Math.floor(inputBudget * COMPACT_BUDGET_FRACTION)) {
        yield { type: "text", content: "*Compacting conversation...*\n\n" };
        const summary = await compactConversation(modelMessages, compactSummary, client, signal);
        if (summary !== null) {
          compactSummary = summary;
          const frame = buildCompactFrame(modelMessages.length, summary);
          conversation.push(...frame);
          modelMessages = [...frame];
          trackEvent("context.compact.applied", {
            iteration,
            tokensBefore: modelTokens,
            messagesAfter: modelMessages.length,
          });
        }
      }
    }
    const trimResult = trimConversationToBudget(modelMessages, inputBudget);

    if (trimResult.removed > 0) {
      trackEvent("context.trim.applied", {
        iteration,
        model: activeModelKey ?? "auto",
        contextWindow,
        budget: inputBudget,
        removedMessages: trimResult.removed,
        tokensBefore: trimResult.tokensBefore,
        tokensAfter: trimResult.tokensAfter,
      });
    }

    if (trimResult.tokensAfter > inputBudget) {
      trackEvent("context.trim.failed", {
        iteration,
        model: activeModelKey ?? "auto",
        contextWindow,
        budget: inputBudget,
        tokensAfter: trimResult.tokensAfter,
      });
      yield {
        type: "error",
        message: "Task context is too large for the selected model window. Start a new task or reduce context files.",
      };
      return;
    }

    // -------------------------------------------------------------------------
    // OUTPUT PATH state — accumulates real model output for tool execution.
    // Thinking content never touches these variables.
    // -------------------------------------------------------------------------
    const assistantBlocks: ContentBlock[] = [];
    let currentText = "";
    let receivedDone = false;

    // -------------------------------------------------------------------------
    // THINKING PATH state — private to <think> tag parsing.
    // Never used to gate output-path processing.
    // -------------------------------------------------------------------------
    let thinkBuffer = "";
    let inThinkTag = false;

    try {
      for await (const event of client.codeStream(
        {
          messages: modelMessages,
          system: systemPrompt,
          tools,
          model: model ?? null,
          enable_thinking: options.enableThinking === true,
        },
        signal
      )) {
        // =========================  THINKING PATH  ===========================
        // Events handled here are display-only. They never touch assistantBlocks,
        // currentText, or any variable that influences tool execution.
        if (event.type === "thinking") {
          yield { type: "thinking_content", content: event.content };
          continue;
        }
        if (event.type === "thinking_done") {
          yield { type: "thinking_done" };
          continue;
        }

        // ==========================  OUTPUT PATH  ============================
        if (event.type === "text") {
          // Route through the <think> tag parser. Segments labelled isThinking
          // go to the thinking display only. Segments outside <think> tags go
          // to currentText for tool processing.
          thinkBuffer += event.content;
          const { output, remaining, isInTag } = processThinkBuffer(thinkBuffer, inThinkTag);
          thinkBuffer = remaining;
          inThinkTag = isInTag;

          for (const seg of output) {
            if (seg.isThinking) {
              // THINKING PATH: display only, never reaches tool execution
              yield { type: "thinking_content", content: seg.text };
            } else {
              // OUTPUT PATH: strip any <tool_call> XML that leaked from thinking,
              // then accumulate for real output processing.
              const cleaned = seg.text
                .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
                .replace(/<tool_call>[\s\S]*/g, "");
              if (cleaned.trim().length > 0) {
                currentText += cleaned;
                yield { type: "text", content: cleaned };
              }
            }
          }

        } else if (event.type === "tool_use") {
          // OUTPUT PATH: tool_use SSE events are always real tool calls.
          // The API never emits them inside a thinking trace — thinking-trace
          // tool calls appear as embedded text/XML, not as structured events.
          // No thinking-state filtering here.
          if (currentText.length > 0) {
            assistantBlocks.push({ type: "text", text: currentText });
            currentText = "";
          }
          assistantBlocks.push({
            type: "tool_use",
            id: event.id,
            name: event.name,
            input: event.input,
          });
          yield { type: "tool_call", id: event.id, name: event.name, input: event.input };
          trackEvent("tool.call", { tool: event.name, iteration });

        } else if (event.type === "done") {
          receivedDone = true;
          activeModelKey = event.model.length > 0 ? event.model : activeModelKey;
          totalCredits += event.credits_used;

          if (costWarningThreshold > 0 && totalCredits >= costWarningThreshold) {
            const cont = await vscode.window.showWarningMessage(
              `Majestix AI: This task has used ${totalCredits.toFixed(1)} credits (threshold: ${String(costWarningThreshold)}). Continue?`,
              "Continue", "Stop"
            );
            if (cont !== "Continue") {
              yield { type: "error", message: `Stopped: cost threshold reached (${totalCredits.toFixed(1)} credits)` };
              return;
            }
          }
          const displayName = event.model_display_name.length > 0 ? event.model_display_name : event.model;
          yield { type: "credits", credits_used: event.credits_used, model: displayName };
          trackEvent("agent.llm.done", {
            iteration,
            model: displayName,
            modelKey: event.model,
            creditsUsed: event.credits_used,
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
          });

        } else {
          // event.type === "error"
          trackEvent("agent.llm.error", { iteration, message: event.detail.slice(0, 200) });

          if (!isNonRecoverableError(event.detail) && isTransientError(event.detail) && transientRetries < MAX_TRANSIENT_RETRIES) {
            transientRetries++;
            trackEvent("agent.transient_retry", { iteration, attempt: transientRetries, reason: event.detail.slice(0, 100) });
            const partial = currentText.trim();
            const ctx = partial.length > 0
              ? `Your previous response was interrupted mid-stream after producing ${String(partial.length)} characters. The partial output was:\n\n${partial}\n\nError: ${event.detail}\n\nContinue from where you were cut off. Do not repeat what was already generated.`
              : `Your previous API call failed with: ${event.detail}\n\nRetry the same operation.`;
            const retryAssistant: Message = { role: "assistant", content: [{ type: "text", text: partial.length > 0 ? partial : `[Failed: ${event.detail}]` }] };
            const retryUser: Message = { role: "user", content: ctx };
            conversation.push(retryAssistant, retryUser);
            modelMessages.push(retryAssistant, retryUser);
            yield { type: "text", content: `\n\n*Retrying after transient error (attempt ${String(transientRetries)}/${String(MAX_TRANSIENT_RETRIES)})...*\n\n` };
            break;
          }
          yield { type: "error", message: event.detail };
          return;
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        trackEvent("agent.cancelled", { iteration });
        yield { type: "error", message: "Cancelled by user" };
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!isNonRecoverableError(errMsg) && isTransientError(errMsg) && transientRetries < MAX_TRANSIENT_RETRIES) {
        transientRetries++;
        trackEvent("agent.transient_retry", { iteration, attempt: transientRetries, reason: errMsg.slice(0, 100) });
        const partial = currentText.trim();
        const ctx = partial.length > 0
          ? `Your previous response was interrupted by a network error after producing ${String(partial.length)} characters. The partial output was:\n\n${partial}\n\nError: ${errMsg}\n\nContinue from where you were cut off. Do not repeat what was already generated.`
          : `The API call failed with: ${errMsg}\n\nRetry the same operation.`;
        const netAssistant: Message = { role: "assistant", content: [{ type: "text", text: partial.length > 0 ? partial : `[Failed: ${errMsg}]` }] };
        const netUser: Message = { role: "user", content: ctx };
        conversation.push(netAssistant, netUser);
        modelMessages.push(netAssistant, netUser);
        yield { type: "text", content: `\n\n*Retrying after network error (attempt ${String(transientRetries)}/${String(MAX_TRANSIENT_RETRIES)})...*\n\n` };
        continue;
      }
      trackEvent("agent.loop.error", { iteration, message: errMsg.slice(0, 200) });
      yield { type: "error", message: errMsg };
      return;
    }

    // Stream ended with no done event — connection dropped
    if (!receivedDone && assistantBlocks.length === 0 && currentText.trim().length === 0) {
      if (transientRetries < MAX_TRANSIENT_RETRIES) {
        transientRetries++;
        trackEvent("agent.transient_retry", { iteration, attempt: transientRetries, reason: "stream_incomplete" });
        const lostAssistant: Message = { role: "assistant", content: [{ type: "text", text: "[Connection lost — stream ended without response]" }] };
        const lostUser: Message = { role: "user", content: "The connection was lost and no response was received. Retry the same operation from scratch." };
        conversation.push(lostAssistant, lostUser);
        modelMessages.push(lostAssistant, lostUser);
        yield { type: "text", content: `\n\n*Connection lost — retrying (attempt ${String(transientRetries)}/${String(MAX_TRANSIENT_RETRIES)})...*\n\n` };
        continue;
      }
      trackEvent("agent.stream.incomplete", { iteration });
      yield { type: "error", message: "Connection lost — the response stream ended unexpectedly. Try again." };
      return;
    }

    // Successful stream — reset transient retry counter
    transientRetries = 0;

    trackEvent("agent.iteration.end", {
      iteration,
      latencyMs: Date.now() - iterationStart,
      toolCalls: assistantBlocks.filter((b) => b.type === "tool_use").length,
    });

    // Flush remaining <think> buffer
    // THINKING PATH: any leftover buffer content goes to display only
    if (thinkBuffer.length > 0) {
      if (inThinkTag) {
        yield { type: "thinking_content", content: thinkBuffer };
      } else if (thinkBuffer.trim().length > 0) {
        // Outside a think tag — the safety-hold buffer is real text
        currentText += thinkBuffer;
        yield { type: "text", content: thinkBuffer };
      }
    }
    if (inThinkTag) {
      yield { type: "thinking_done" };
    }

    // Flush remaining output text into assistantBlocks
    if (currentText.length > 0) {
      assistantBlocks.push({ type: "text", text: currentText });
    }

    if (assistantBlocks.length > 0) {
      const assistantMsg: Message = { role: "assistant", content: assistantBlocks };
      conversation.push(assistantMsg);
      modelMessages.push(assistantMsg);
    }

    const toolCalls = assistantBlocks.filter(
      (b): b is ContentBlock & { type: "tool_use" } => b.type === "tool_use"
    );

    if (toolCalls.length === 0) {
      if (currentText.trim().length > 0) {
        // Text-only answer — task is done
        break;
      }
      // Empty output (model produced only thinking, or nothing).
      // emptyResponseRetries does NOT reset per iteration — prevents infinite loop.
      if (emptyResponseRetries < MAX_TRANSIENT_RETRIES) {
        emptyResponseRetries++;
        trackEvent("agent.empty_response_retry", { iteration, attempt: emptyResponseRetries });
        const emptyAssistant: Message = { role: "assistant", content: [{ type: "text", text: "[Empty response received]" }] };
        const emptyUser: Message = { role: "user", content: "Your previous response was empty — no text and no tool calls were returned. Please continue with the task." };
        conversation.push(emptyAssistant, emptyUser);
        modelMessages.push(emptyAssistant, emptyUser);
        yield { type: "text", content: `\n\n*Empty response — retrying (${String(emptyResponseRetries)}/${String(MAX_TRANSIENT_RETRIES)})...*\n\n` };
        continue;
      }
      yield { type: "error", message: "The model returned an empty response. Try rephrasing your request or selecting a different model." };
      break;
    }
    emptyResponseRetries = 0;

    // --- Execute each tool ---
    const toolResults: ContentBlock[] = [];
    errorTracker.resetTurn();

    for (const toolCall of toolCalls) {
      const originalName = toolCall.name;
      let resolvedName = resolveToolName(toolCall.name);

      if (originalName === "str_replace_editor" || originalName === "str_replace_command") {
        const subCmd = typeof toolCall.input.command === "string" ? toolCall.input.command : "";
        if (subCmd === "view") {
          resolvedName = "read_file";
        } else if (subCmd === "create" || toolCall.input.file_text !== undefined) {
          resolvedName = "write_to_file";
        }
      }

      if (resolvedName !== originalName) {
        trackEvent("tool.alias_resolved", { from: originalName, to: resolvedName, iteration });
        toolCall.name = resolvedName;
        normalizeAliasedInput(originalName, resolvedName, toolCall.input);
      }

      const handler = getToolHandler(toolCall.name, mode);
      if (handler === undefined) {
        trackEvent("tool.error", { tool: toolCall.name, reason: "unknown_tool", iteration });
        const available = getToolNames(mode);
        const escalation = errorTracker.recordFailure(toolCall.name);
        const errorContent = `Unknown tool: "${toolCall.name}". Available tools: ${available.join(", ")}. Use ONLY these tool names.${escalation ?? ""}`;
        toolResults.push({ type: "tool_result", tool_use_id: toolCall.id, content: errorContent, is_error: true });
        yield { type: "tool_result", id: toolCall.id, name: toolCall.name, content: errorContent, is_error: true };
        continue;
      }

      const autoApprove = vscode.workspace.getConfiguration("majestix").get<string>("autoApprove", "none");
      const commandStr = typeof toolCall.input.command === "string" ? toolCall.input.command : "";
      const isReadOnlyCommand = toolCall.name === "execute_command" &&
        /^\s*(ls|cat|head|tail|wc|file|stat|which|echo|pwd|whoami|date|env|printenv|git\s+(status|log|diff|branch|remote|show|rev-parse)|npm\s+(ls|list|outdated|audit)|node\s+(-v|--version)|python\s+(-V|--version))\b/.test(commandStr);
      const shouldAutoApprove = autoApprove === "all" || (autoApprove === "readOnly" && isReadOnlyCommand);

      if (handler.requiresApproval(toolCall.input) && !shouldAutoApprove) {
        const description = formatToolDescription(toolCall.name, toolCall.input);
        const diffSummary = (toolCall.name === "write_to_file" || toolCall.name === "edit_file" || toolCall.name === "apply_patch")
          ? await computeFileDiffSummary(workspaceRoot, toolCall.name, toolCall.input)
          : undefined;
        const approved = await requestApproval(toolCall.name, description, diffSummary);

        if (!approved) {
          trackEvent("approval.rejected", { tool: toolCall.name, iteration });
          const rejectedPath = toolCall.input.path as string | undefined;
          if (rejectedPath !== undefined && (toolCall.name === "write_to_file" || toolCall.name === "edit_file")) {
            try {
              const uri = resolveWorkspacePath(workspaceRoot, rejectedPath);
              await revertFile(uri);
            } catch { /* no backup to revert */ }
          }
          toolResults.push({ type: "tool_result", tool_use_id: toolCall.id, content: "User rejected this action.", is_error: true });
          yield { type: "tool_result", id: toolCall.id, name: toolCall.name, content: "User rejected this action.", is_error: true };
          continue;
        }
      }

      const filePath = typeof toolCall.input.path === "string" ? toolCall.input.path : undefined;
      try {
        const result = await handler.execute(toolCall.input, toolContext);
        result.tool_use_id = toolCall.id;

        // Hard cap: truncate oversized tool output before it enters the conversation.
        if (result.content.length > MAX_TOOL_RESULT_CHARS) {
          const originalLen = result.content.length;
          result.content =
            result.content.slice(0, TOOL_RESULT_HEAD) +
            `\n\n[... truncated — ${String(originalLen)} chars total, showing first ${String(TOOL_RESULT_HEAD)} + last ${String(TOOL_RESULT_TAIL)} chars ...]\n\n` +
            result.content.slice(-TOOL_RESULT_TAIL);
          trackEvent("tool.result.truncated", { tool: toolCall.name, originalChars: originalLen });
        }

        if (result.is_error === true) {
          const escalation = errorTracker.recordFailure(toolCall.name, filePath);
          if (escalation !== null) { result.content += escalation; }
        } else {
          errorTracker.recordSuccess(toolCall.name, filePath);
        }

        toolResults.push({ type: "tool_result", tool_use_id: toolCall.id, content: result.content, is_error: result.is_error });
        yield { type: "tool_result", id: toolCall.id, name: toolCall.name, content: result.content, is_error: result.is_error };

        if (result.is_error !== true) {
          if (toolCall.name === "write_to_file" || toolCall.name === "edit_file") {
            const editPath = typeof toolCall.input.path === "string" ? toolCall.input.path : "file";
            yield { type: "file_edited", path: editPath, op: toolCall.name === "write_to_file" ? "write" : "edit" };
          } else if (toolCall.name === "apply_patch") {
            for (const line of result.content.split("\n").slice(1)) {
              const m = /^(.+?): (?:\d+ chunk|created)/.exec(line.trim());
              if (m) {
                yield { type: "file_edited", path: m[1], op: line.includes("created") ? "write" : "patch" };
              }
            }
          }
        }

        if (toolCall.name === "attempt_completion") {
          completed = true;
          yield { type: "completion", result: toolCall.input.result as string, command: toolCall.input.command as string | undefined };
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        trackEvent("tool.error", { tool: toolCall.name, reason: "execution_error", iteration, message: errMsg.slice(0, 200) });
        const escalation = errorTracker.recordFailure(toolCall.name, filePath);
        const errorContent = `Tool execution error: ${errMsg}${escalation ?? ""}`;
        toolResults.push({ type: "tool_result", tool_use_id: toolCall.id, content: errorContent, is_error: true });
        yield { type: "tool_result", id: toolCall.id, name: toolCall.name, content: errorContent, is_error: true };
      }
    }

    if (errorTracker.shouldStop) {
      trackEvent("agent.error_limit", { iteration, consecutiveMistakes: errorTracker.consecutiveMistakes });
      yield { type: "error", message: `Stopped after ${String(errorTracker.consecutiveMistakes)} consecutive tool failures. The agent could not recover. Review the errors above and try a different approach.` };
      break;
    }

    if (completed) { break; }

    if (toolResults.length > 0) {
      const toolResultMsg: Message = { role: "user", content: toolResults };
      conversation.push(toolResultMsg);
      modelMessages.push(toolResultMsg);
    }
  }

  clearAllBackups();

  if (iteration >= maxIterations) {
    trackEvent("agent.max_iterations", { maxIterations });
    yield { type: "error", message: `Max iterations (${String(maxIterations)}) reached` };
  }

  trackEvent("agent.done", { iterations: iteration, totalCredits });
  yield { type: "done", total_credits: totalCredits, iterations: iteration, conversation: [...conversation], compact_summary: compactSummary };
}
