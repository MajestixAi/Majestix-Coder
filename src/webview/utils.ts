/** Shared utility functions for the webview. */

/** Get the VS Code API handle (set by index.tsx on startup). */
function getVsCodeApi(): { postMessage(msg: unknown): void } {
  return (globalThis as unknown as { vscodeApi: { postMessage(msg: unknown): void } }).vscodeApi;
}

/** Post a message to the extension host. */
export function postMessage(msg: unknown): void {
  getVsCodeApi().postMessage(msg);
}

/** HTML-escape a string. */
export function escapeHtml(text: string): string {
  if (!text) return "";
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

/** Render markdown using the bundled marked + highlight.js library (webview-markdown.js).
 *  All normalization (escaped newlines, table fixes, etc.) is handled inside markdown.ts.
 *  This wrapper just delegates — do NOT add extra transforms here. */
export function renderMarkdown(text: string): string {
  if (!text) return "";
  try {
    const wm = (globalThis as unknown as { webviewMarkdown?: { renderMarkdown(s: string): string } }).webviewMarkdown;
    if (!wm) {
      console.error("[Majestix] webviewMarkdown global not found — markdown script may not have loaded");
      return "<p>" + escapeHtml(text) + "</p>";
    }
    return wm.renderMarkdown(text);
  } catch (err) {
    console.error("[Majestix] renderMarkdown failed:", err);
    return "<p>" + escapeHtml(text) + "</p>";
  }
}

/** Tool name → emoji icon. */
export function toolIcon(name: string): string {
  const icons: Record<string, string> = {
    read_file: "\ud83d\udcd6",
    write_to_file: "\u270f\ufe0f",
    edit_file: "\u270f\ufe0f",
    execute_command: "\u25b6",
    search_files: "\ud83d\udd0d",
    list_files: "\ud83d\udcc2",
    attempt_completion: "\u2705",
  };
  return icons[name] ?? "\ud83d\udd27";
}

/** Short description for a tool call's input. */
export function toolDescription(name: string, input: Record<string, unknown>): string {
  if (name === "read_file" || name === "write_to_file" || name === "edit_file") return (input.path as string | undefined) ?? "";
  if (name === "execute_command") return (input.command as string | undefined) ?? "";
  if (name === "search_files") return (input.pattern as string | undefined) ?? "";
  if (name === "list_files") return (input.path as string | undefined) ?? ".";
  if (name === "attempt_completion") return ((input.result as string | undefined) ?? "").slice(0, 60);
  return JSON.stringify(input).slice(0, 60);
}

/** Classify an error message for actionable UI. */
export function classifyError(message: string): { title: string; detail: string; cssClass: string } {
  const lower = (message || "").toLowerCase();
  if (lower.includes("invalid api key") || lower.includes("401")) {
    return { title: "Invalid API Key", detail: "Your API key is invalid or expired. Update it to continue.", cssClass: "error-quota" };
  }
  if (lower.includes("quota") || lower.includes("out of credits") || lower.includes("insufficient credits") || lower.includes("credits exhausted") || lower.includes("402")) {
    return { title: "Out of Credits", detail: message, cssClass: "error-quota" };
  }
  if (lower.includes("rate limit") || lower.includes("rate_limit") || lower.includes("too many requests") || lower.includes("429")) {
    return { title: "Rate Limited", detail: message, cssClass: "error-rate" };
  }
  if (lower.includes("context is too large") || lower.includes("token")) {
    return { title: "Context Too Large", detail: "The conversation context exceeds the model limit. Start a new chat or reduce attached files.", cssClass: "error-context" };
  }
  if (lower.includes("empty response")) {
    return { title: "Empty Response", detail: "The model returned no content. Try a more capable model or break the task into smaller steps.", cssClass: "error-context" };
  }
  if (lower.includes("tool-use mode") || lower.includes("tool calling") || lower.includes("does not support tool")) {
    return { title: "Model Not Compatible", detail: "This model doesn\u2019t support Code mode. Switch to a tool-capable model like Claude Sonnet or GPT-4o.", cssClass: "error-context" };
  }
  if (lower.includes("service unavailable") || lower.includes("503") || lower.includes("network") || lower.includes("fetch")) {
    return { title: "Connection Error", detail: "Could not reach the Majestix API. Check your internet connection and try again.", cssClass: "error-rate" };
  }
  return { title: "Error", detail: message, cssClass: "" };
}

/** Group sessions by relative date label. */
export function groupSessionsByDate(sessions: { updated_at: string }[]): Map<string, typeof sessions> {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  const groups = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const d = new Date(s.updated_at);
    let label: string;
    if (d >= today) label = "Today";
    else if (d >= yesterday) label = "Yesterday";
    else if (d >= weekAgo) label = "This Week";
    else label = d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
    if (!groups.has(label)) groups.set(label, []);
    const group = groups.get(label);
    if (group) group.push(s);
  }
  return groups;
}

/**
 * A single assistant turn in the downloaded chat file.
 * Contains thinking, text, tools, and metadata from one logical response.
 */
interface Turn {
  thinking?: string;
  text?: string;
  tools?: TurnTool[];
  fileEdits?: string[];
  credits?: string;
  error?: string;
  completion?: string;
}

interface TurnTool {
  name: string;
  result?: string;
  isError?: boolean;
}

/** Generate download content from conversation items. */
export function generateDownloadContent(items: { kind: string; [key: string]: unknown }[], model: string): string {
  const NL = "\n";
  const lines = [
    "# Majestix AI Chat Session", "",
    "Date: " + new Date().toLocaleString(),
    "Model: " + (model || "Auto"), "", "---", "",
  ];

  // Group consecutive assistant items (ai-text + thinking) into single turns.
  // The webview creates a separate item per SSE chunk, so the same assistant
  // response can be split across multiple ai-text/thinking items. We merge
  // them so the downloaded file reads naturally.
  const turns: Turn[] = [];

  let currentTurn: Turn = {};
  let hasCurrentTurn = false;

  for (const item of items) {
    switch (item.kind) {
      case "user":
        // Flush any pending turn
        if (hasCurrentTurn) {
          turns.push(currentTurn);
          currentTurn = {};
          hasCurrentTurn = false;
        }
        lines.push("## User", "", (item.text as string | undefined) ?? "", "", "---", "");
        break;

      case "ai-text":
        if (!hasCurrentTurn) {
          currentTurn = {};
          hasCurrentTurn = true;
        }
        currentTurn.text = (currentTurn.text ?? "") + (item.content as string);
        break;

      case "thinking": {
        const thinking = item.thinking as { content?: string } | undefined;
        const thinkText = thinking?.content ?? "";
        if (thinkText) {
          if (!hasCurrentTurn) {
            currentTurn = {};
            hasCurrentTurn = true;
          }
          currentTurn.thinking = (currentTurn.thinking ?? "") + thinkText;
        }
        break;
      }

      case "tool-call": {
        if (!hasCurrentTurn) {
          currentTurn = {};
          hasCurrentTurn = true;
        }
        const tool = item.tool as { name: string; input?: Record<string, unknown>; result?: string; isError?: boolean };
        currentTurn.tools ??= [];
        currentTurn.tools.push({
          name: tool.name,
          result: tool.result,
          isError: tool.isError,
        });
        break;
      }

      case "tool-result": {
        // Append result to the last tool call in this turn
        if (hasCurrentTurn && currentTurn.tools && currentTurn.tools.length > 0) {
          const lastTool = currentTurn.tools[currentTurn.tools.length - 1];
          if (lastTool.result === undefined || lastTool.result === "Running...") {
            lastTool.result = (item.content as string | undefined) ?? "";
            lastTool.isError = (item.isError as boolean | undefined) ?? false;
          }
        }
        break;
      }

      case "approval": {
        if (!hasCurrentTurn) {
          currentTurn = {};
          hasCurrentTurn = true;
        }
        // Track approvals as part of the turn
        currentTurn.tools ??= [];
        const approval = item.approval as { toolName?: string; description?: string; approved?: boolean; resolved?: boolean } | undefined;
        if (approval) {
          const status = approval.resolved ? (approval.approved ? "Allowed" : "Rejected") : "Pending";
          currentTurn.tools.push({
            name: `approval (${approval.toolName ?? "unknown"})`,
            result: `${approval.description ?? ""} → ${status}`,
            isError: false,
          });
        }
        break;
      }

      case "completion":
        if (!hasCurrentTurn) {
          currentTurn = {};
          hasCurrentTurn = true;
        }
        currentTurn.completion = (item.result as string | undefined) ?? "";
        break;

      case "credits": {
        if (!hasCurrentTurn) {
          currentTurn = {};
          hasCurrentTurn = true;
        }
        const creditModel = (item.model as string | undefined) ?? "";
        const creditAmount = (item.credits as number | undefined) ?? 0;
        const creditLine = `*${creditModel} · ${creditAmount.toFixed(2)} cr*`;
        currentTurn.credits = (currentTurn.credits ?? "") + " " + creditLine;
        break;
      }

      case "error":
        if (!hasCurrentTurn) {
          currentTurn = {};
          hasCurrentTurn = true;
        }
        currentTurn.error = (item.message as string | undefined) ?? "";
        break;

      case "file-edit": {
        if (!hasCurrentTurn) {
          currentTurn = {};
          hasCurrentTurn = true;
        }
        const opLabel = (item.op as string) === "write" ? "Created" : (item.op as string) === "edit" ? "Edited" : "Patched";
        currentTurn.fileEdits ??= [];
        currentTurn.fileEdits.push(`> ✏️ **${opLabel}:** \`${item.path as string}\``);
        break;
      }

      case "garble-warning":
        if (!hasCurrentTurn) {
          currentTurn = {};
          hasCurrentTurn = true;
        }
        // Append garble warning to the turn
        currentTurn.error ??= "";
        currentTurn.error += (currentTurn.error ? "\n" : "") + "Model compatibility issue — unrecognized tool-call syntax";
        break;

      case "turn-start":
        // Ignore — structural only
        break;

      default:
        break;
    }
  }

  // Flush the last turn
  if (hasCurrentTurn) {
    turns.push(currentTurn);
  }

  // Merge consecutive text-only turns — when the model produces text across
  // multiple iterations (e.g. long responses split by SSE streams), each
  // iteration creates a separate turn. Merge them so the downloaded file
  // reads as one coherent assistant response.
  const mergedTurns: Turn[] = [];
  for (const turn of turns) {
    const hasOnlyText =
      turn.text !== undefined &&
      turn.text.trim().length > 0 &&
      !turn.thinking &&
      !turn.tools &&
      !turn.fileEdits &&
      !turn.credits &&
      !turn.completion &&
      !turn.error;

    if (hasOnlyText && mergedTurns.length > 0) {
      const last = mergedTurns[mergedTurns.length - 1];
      const lastText = last.text;
      const turnText = turn.text;
      if (lastText && turnText) {
        const lastHasOnlyText =
          !last.thinking &&
          !last.tools &&
          !last.fileEdits &&
          !last.credits &&
          !last.completion &&
          !last.error;
        if (lastHasOnlyText) {
          last.text = (lastText + "\n\n" + turnText).trim();
          continue;
        }
      }
    }
    mergedTurns.push(turn);
  }

  // Now write the turns to the output
  for (const turn of mergedTurns) {
    // Thinking block
    if (turn.thinking) {
      lines.push("<details><summary>Thinking</summary>", "", turn.thinking, "", "</details>", "");
    }

    // Main text
    if (turn.text) {
      lines.push("## Assistant", "", turn.text.trim(), "", "---", "");
    }

    // Tool calls
    if (turn.tools) {
      for (const tool of turn.tools) {
        if (tool.name.startsWith("approval (")) {
          // Approval line
          const match = tool.result?.match(/^(.+?) → (Allowed|Rejected|Pending)$/);
          if (match) {
            lines.push(`> **Approval: ${tool.name.slice(10, -1)}** — ${match[1]} → ${match[2]}`, "");
          } else {
            lines.push(`> **Tool: ${tool.name}** (${tool.result ?? ""})`, "");
          }
        } else if (tool.result && tool.result !== "Running...") {
          const status = tool.isError ? "FAILED" : "OK";
          lines.push(`**Tool: ${tool.name}** (${status})`);
          lines.push("```", tool.result.slice(0, 4000), "```", "");
        }
      }
    }

    // File edits
    if (turn.fileEdits) {
      for (const fe of turn.fileEdits) {
        lines.push(fe, "");
      }
    }

    // Credits
    if (turn.credits) {
      lines.push(turn.credits.trim(), "");
    }

    // Completion
    if (turn.completion) {
      lines.push("## Completed", "", turn.completion, "", "---", "");
    }

    // Errors
    if (turn.error) {
      lines.push("## Error", "", "> " + turn.error, "", "---", "");
    }
  }

  return lines.join(NL);
}
