import * as vscode from "vscode";
import { MajestixClient } from "../api/client";
import { getActiveFileContext } from "../context/active-file";
import { revealChatPanel } from "../sidebar/reveal";

/**
 * Registers the "Fix Error" command which gathers diagnostics or selected code
 * and sends them to the sidebar chat for AI-assisted fixing.
 *
 * @param client - The Majestix API client (unused directly but kept for consistency).
 * @param postToSidebar - Callback to post a message object to the sidebar webview.
 * @returns A disposable representing the registered command.
 */
export function registerFixCommand(
  client: MajestixClient,
  postToSidebar: (msg: unknown) => void
): vscode.Disposable {
  return vscode.commands.registerCommand("majestix.fix", async () => {
    const ctx = getActiveFileContext();
    if (ctx === null) {
      void vscode.window.showWarningMessage("Open a file first.");
      return;
    }

    if (ctx.diagnostics.length === 0 && ctx.selection === undefined) {
      void vscode.window.showInformationMessage("No errors or warnings found, and no code selected.");
      return;
    }

    let message: string;

    if (ctx.diagnostics.length > 0) {
      const diagText = ctx.diagnostics
        .map((d) => `  Line ${String(d.line)} [${d.severity}]: ${d.message}`)
        .join("\n");

      message = `Fix these errors/warnings in \`${ctx.filePath}\`:\n\n${diagText}\n\nReturn ONLY the corrected code inside a single fenced code block.\n\n\`\`\`${ctx.language}\n${ctx.content}\n\`\`\``;
    } else {
      const selText = ctx.selection !== undefined ? ctx.selection.text : "";
      message = `Fix any issues in this code. Return ONLY the corrected code inside a single fenced code block.\n\nFile: \`${ctx.filePath}\` (${ctx.language})\n\`\`\`${ctx.language}\n${selText}\n\`\`\``;
    }

    postToSidebar({ type: "ask", message, rawQuestion: "Fix errors" });
    await revealChatPanel();
  });
}
