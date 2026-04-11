import * as vscode from "vscode";

import { runAgentLoop } from "../agent/loop";
import { MajestixClient } from "../api/client";

interface TodoItem {
  text: string;
  lineNumber: number;
}

/**
 * Parse unchecked Markdown checkbox items (`- [ ] text`) from a document's text.
 *
 * @param text - Raw document content.
 * @returns Array of todo items with their text and line number.
 */
function parseTodoItems(text: string): TodoItem[] {
  const items: TodoItem[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)-\s+\[ \]\s+(.+)/.exec(lines[i]);
    if (match !== null) {
      items.push({ text: match[2].trim(), lineNumber: i });
    }
  }
  return items;
}

/**
 * Check off a specific todo item in the markdown file by matching its text content.
 * Re-reads the document so line numbers stay correct even if prior tasks modified it.
 *
 * @param docUri - URI of the markdown file to update.
 * @param itemText - The todo item text to search for and check off.
 */
async function checkOffItem(docUri: vscode.Uri, itemText: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(docUri);
  const lines = doc.getText().split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("- [ ]") && lines[i].includes(itemText)) {
      const lineRange = doc.lineAt(i).range;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(docUri, lineRange, lines[i].replace("- [ ]", "- [x]"));
      await vscode.workspace.applyEdit(edit);
      await doc.save();
      break;
    }
  }
}

/**
 * Registers the `majestix.runTodos` command which parses a Markdown file for
 * unchecked checkbox items and runs each as a sequential background agent task.
 *
 * @param client - The Majestix API client used for agent loop calls.
 * @returns A disposable for the registered command.
 */
export function registerRunTodosCommand(client: MajestixClient): vscode.Disposable {
  return vscode.commands.registerCommand("majestix.runTodos", async () => {
    // ── 1. Resolve the source markdown file ──
    let docUri: vscode.Uri | undefined;
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor?.document.languageId === "markdown") {
      docUri = activeEditor.document.uri;
    } else {
      const files = await vscode.workspace.findFiles("**/*.md", "**/node_modules/**", 50);
      if (files.length === 0) {
        void vscode.window.showErrorMessage("Majestix AI: No markdown files found in the workspace.");
        return;
      }
      const items = files.map((f) => ({
        label: vscode.workspace.asRelativePath(f),
        uri: f,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a markdown file containing todo items",
      });
      if (picked === undefined) { return; }
      docUri = picked.uri;
    }

    // ── 2. Parse todo items ──
    const doc = await vscode.workspace.openTextDocument(docUri);
    const todos = parseTodoItems(doc.getText());
    if (todos.length === 0) {
      void vscode.window.showInformationMessage(
        "Majestix AI: No unchecked items found. Use `- [ ] task text` syntax."
      );
      return;
    }

    // ── 3. Let user select which items to run ──
    const qpItems = todos.map((t) => ({
      label: t.text,
      lineNumber: t.lineNumber,
      picked: true,
    }));
    const selected = await vscode.window.showQuickPick(qpItems, {
      canPickMany: true,
      placeHolder: `Select todo items to run as agent tasks (${String(todos.length)} found)`,
    });
    if (selected === undefined || selected.length === 0) { return; }

    // ── 4. Confirm ──
    const confirm = await vscode.window.showWarningMessage(
      `Run ${String(selected.length)} todo item${selected.length === 1 ? "" : "s"} as agent tasks? ` +
      "The agent will read and modify files in your workspace.",
      { modal: true },
      "Run Tasks"
    );
    if (confirm !== "Run Tasks") { return; }

    // ── 5. Execute sequentially with progress UI ──
    const config = vscode.workspace.getConfiguration("majestix");
    const autoApprove = config.get<string>("autoApprove", "none");

    const abort = new AbortController();
    let completed = 0;
    let failed = 0;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Majestix AI",
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => { abort.abort(); });

        for (let i = 0; i < selected.length; i++) {
          if (abort.signal.aborted) { break; }

          const todo = selected[i];
          const step = `Task ${String(i + 1)}/${String(selected.length)}`;
          const shortLabel = todo.label.length > 55 ? todo.label.slice(0, 55) + "…" : todo.label;
          progress.report({ message: `${step}: ${shortLabel}`, increment: 0 });

          const task =
            "Complete the following task from my todo list:\n\n" +
            `${todo.label}\n\n` +
            "When finished, call attempt_completion with a concise summary of what was done.";

          // Approval callback — respects autoApprove setting, falls back to modal dialog.
          const requestApproval = async (
            toolName: string,
            description: string
          ): Promise<boolean> => {
            if (autoApprove === "all") { return true; }
            if (autoApprove === "readOnly") {
              const readOnlyPattern =
                /^\s*(ls|cat|head|tail|wc|file|stat|which|echo|pwd|whoami|date|env|printenv|git\s+(status|log|diff|branch|remote|show|rev-parse)|npm\s+(ls|list|outdated|audit)|node\s+(-v|--version)|python\s+(-V|--version))\b/;
              if (readOnlyPattern.test(description)) { return true; }
            }
            const answer = await vscode.window.showWarningMessage(
              `Majestix Todo Runner — Allow "${toolName}"?\n${description}`,
              { modal: true },
              "Allow",
              "Reject"
            );
            return answer === "Allow";
          };

          try {
            const taskErrors: string[] = [];
            for await (const event of runAgentLoop(task, {
              mode: "code",
              client,
              postMessage: () => { /* background — no sidebar */ },
              requestApproval,
              signal: abort.signal,
            })) {
              if (event.type === "error") {
                taskErrors.push(event.message);
                break;
              }
            }
            if (taskErrors.length > 0) {
              void vscode.window.showErrorMessage(
                `Majestix AI: Todo task failed \u2014 ${taskErrors[0] ?? "unknown error"}`
              );
              failed++;
            } else {
              await checkOffItem(docUri, todo.label);
              completed++;
            }
          } catch (err) {
            // abort.abort() is called via cancellation token — aborted may be true here
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (!abort.signal.aborted) {
              failed++;
              void vscode.window.showErrorMessage(
                `Majestix AI: Todo task error \u2014 ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }

          progress.report({ increment: 100 / selected.length });
        }
      }
    );

    // ── 6. Summary notification ──
    if (completed > 0 || failed > 0) {
      const parts: string[] = [];
      if (completed > 0) { parts.push(`${String(completed)} completed`); }
      if (failed > 0) { parts.push(`${String(failed)} failed`); }
      if (abort.signal.aborted && completed + failed < selected.length) {
        parts.push("cancelled");
      }
      void vscode.window.showInformationMessage(
        `Majestix AI Todo Runner: ${parts.join(", ")}.`
      );
    }
  });
}
