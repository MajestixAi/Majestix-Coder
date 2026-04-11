import * as vscode from "vscode";
import { MajestixClient } from "../api/client";
import { getActiveFileContext } from "../context/active-file";
import { revealChatPanel } from "../sidebar/reveal";

/**
 * Registers the "Generate Code" command which prompts the user for a description
 * and sends a code generation request to the sidebar chat.
 *
 * @param client - The Majestix API client (unused directly but kept for consistency).
 * @param postToSidebar - Callback to post a message object to the sidebar webview.
 * @returns A disposable representing the registered command.
 */
export function registerGenerateCommand(
  client: MajestixClient,
  postToSidebar: (msg: unknown) => void
): vscode.Disposable {
  return vscode.commands.registerCommand("majestix.generate", async () => {
    const description = await vscode.window.showInputBox({
      title: "Generate Code",
      prompt: "Describe the code you want to generate",
      placeHolder: "e.g. A function that validates email addresses using regex",
      ignoreFocusOut: true,
    });

    if (description === undefined || description === "") {return;}

    const ctx = getActiveFileContext();
    let message = `Generate code: ${description}\n\nReturn ONLY the code inside a single fenced code block. No explanations outside the code block.`;

    if (ctx !== null) {
      message += `\n\nContext — active file: \`${ctx.filePath}\` (${ctx.language})`;
    }

    postToSidebar({
      type: "ask",
      message,
      rawQuestion: `Generate: ${description}`,
    });
    await revealChatPanel();
  });
}
