import * as vscode from "vscode";
import { MajestixClient } from "../api/client";
import { getSelectedText } from "../context/active-file";
import { revealChatPanel } from "../sidebar/reveal";

/**
 * Registers the "Refactor" command which sends selected code to the sidebar chat
 * with a user-specified refactoring instruction.
 *
 * @param client - The Majestix API client (unused directly but kept for consistency).
 * @param postToSidebar - Callback to post a message object to the sidebar webview.
 * @returns A disposable representing the registered command.
 */
export function registerRefactorCommand(
  client: MajestixClient,
  postToSidebar: (msg: unknown) => void
): vscode.Disposable {
  return vscode.commands.registerCommand("majestix.refactor", async () => {
    const sel = getSelectedText();
    if (sel === null) {
      void vscode.window.showWarningMessage("Select some code first.");
      return;
    }

    const instruction = await vscode.window.showInputBox({
      title: "Refactor",
      prompt: "How should this code be refactored?",
      placeHolder: "e.g. Extract into a separate function, use async/await, simplify",
      ignoreFocusOut: true,
    });

    if (instruction === undefined || instruction === "") {return;}

    const message = `Refactor this code. ${instruction}\n\nReturn ONLY the refactored code inside a single fenced code block. No explanations outside the code block.\n\nFile: \`${sel.filePath}\` (lines ${String(sel.startLine)}–${String(sel.endLine)})\n\`\`\`${sel.language}\n${sel.text}\n\`\`\``;

    postToSidebar({
      type: "ask",
      message,
      rawQuestion: `Refactor: ${instruction}`,
    });
    await revealChatPanel();
  });
}
