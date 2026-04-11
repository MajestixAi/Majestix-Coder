import * as vscode from "vscode";
import { MajestixClient } from "../api/client";
import { getSelectedText } from "../context/active-file";
import { revealChatPanel } from "../sidebar/reveal";

// Command: explain
/**
 * Registers the "Explain Code" command which sends selected code to the sidebar chat
 * asking for a clear and concise explanation.
 *
 * @param client - The Majestix API client (unused directly but kept for consistency).
 * @param postToSidebar - Callback to post a message object to the sidebar webview.
 * @returns A disposable representing the registered command.
 */
export function registerExplainCommand(
  client: MajestixClient,
  postToSidebar: (msg: unknown) => void
): vscode.Disposable {
  return vscode.commands.registerCommand("majestix.explain", async () => {
    const sel = getSelectedText();
    if (sel === null) {
      void vscode.window.showWarningMessage("Select some code first.");
      return;
    }

    const message = `Explain this code clearly and concisely:\n\nFile: \`${sel.filePath}\` (lines ${String(sel.startLine)}–${String(sel.endLine)})\n\`\`\`${sel.language}\n${sel.text}\n\`\`\``;

    postToSidebar({ type: "ask", message, rawQuestion: "Explain selected code" });
    await revealChatPanel();
  });
}
