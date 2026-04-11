import * as vscode from "vscode";
import { MajestixClient } from "../api/client";
import { getSelectedText, getActiveFileContext } from "../context/active-file";
import { revealChatPanel } from "../sidebar/reveal";

/**
 * Registers the "Review Code" command which sends selected code or the full active file
 * to the sidebar chat for an AI-powered code review.
 *
 * @param client - The Majestix API client (unused directly but kept for consistency).
 * @param postToSidebar - Callback to post a message object to the sidebar webview.
 * @returns A disposable representing the registered command.
 */
export function registerReviewCommand(
  client: MajestixClient,
  postToSidebar: (msg: unknown) => void
): vscode.Disposable {
  return vscode.commands.registerCommand("majestix.review", async () => {
    const sel = getSelectedText();
    const ctx = getActiveFileContext();

    if (sel === null && ctx === null) {
      void vscode.window.showWarningMessage("Open a file or select code first.");
      return;
    }

    let message: string;

    if (sel !== null) {
      message = `Review this code for bugs, performance issues, security vulnerabilities, and code quality. Be specific and actionable.\n\nFile: \`${sel.filePath}\` (lines ${String(sel.startLine)}–${String(sel.endLine)})\n\`\`\`${sel.language}\n${sel.text}\n\`\`\``;
    } else if (ctx !== null) {
      message = `Review this file for bugs, performance issues, security vulnerabilities, and code quality. Be specific and actionable.\n\nFile: \`${ctx.filePath}\` (${ctx.language})\n\`\`\`${ctx.language}\n${ctx.content}\n\`\`\``;
    } else {
      return;
    }

    postToSidebar({ type: "ask", message, rawQuestion: "Review code" });
    await revealChatPanel();
  });
}
