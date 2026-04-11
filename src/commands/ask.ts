import * as vscode from "vscode";
import { MajestixClient } from "../api/client";
import { ChatPanelProvider } from "../sidebar/chat-panel";
import { getActiveFileContext } from "../context/active-file";
import { revealChatPanel } from "../sidebar/reveal";

// Command: ask
/**
 * Registers the "Ask AI" command which opens an input box, collects workspace context,
 * and sends the question to the sidebar chat panel.
 *
 * @param client - The Majestix API client (unused directly but kept for consistency).
 * @param postToSidebar - Callback to post a message object to the sidebar webview.
 * @param chatPanel - Optional chat panel provider used to focus the input after reveal.
 * @returns A disposable representing the registered command.
 */
export function registerAskCommand(
  client: MajestixClient,
  postToSidebar: (msg: unknown) => void,
  chatPanel?: ChatPanelProvider
): vscode.Disposable {
  return vscode.commands.registerCommand("majestix.ask", async () => {
    const question = await vscode.window.showInputBox({
      title: "Ask AI",
      prompt: "What would you like to ask?",
      placeHolder: "e.g. How do I add pagination to this API?",
      ignoreFocusOut: true,
    });

    if (question === undefined || question === "") {
      // If user cancelled the input box, still reveal and focus the sidebar input
      await revealChatPanel();
      chatPanel?.focusInput();
      return;
    }

    // Collect active file context
    const fileCtx = getActiveFileContext();

    let message = question;
    if (fileCtx !== null) {
      message = `${question}\n\n---\nActive file: \`${fileCtx.filePath}\` (${fileCtx.language})`;
      if (fileCtx.selection !== undefined) {
        message += `\nSelected code (lines ${String(fileCtx.selection.start)}–${String(fileCtx.selection.end)}):\n\`\`\`${fileCtx.language}\n${fileCtx.selection.text}\n\`\`\``;
      }
    }

    // Send to sidebar
    postToSidebar({
      type: "ask",
      message,
      rawQuestion: question,
    });

    await revealChatPanel();
    chatPanel?.focusInput();
  });
}
