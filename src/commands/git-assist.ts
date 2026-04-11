import * as cp from "child_process";
import * as vscode from "vscode";

import { MajestixClient } from "../api/client";

/**
 * Run a git command in the given working directory and return its trimmed stdout.
 *
 * @param args - Git arguments (e.g. `["diff", "--staged", "--stat"]`).
 * @param cwd - Working directory (workspace root).
 * @returns Trimmed stdout string, or empty string if the command fails / produces no output.
 */
function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    cp.execFile("git", args, { cwd, maxBuffer: 500_000 }, (_err, stdout) => {
      resolve(stdout.trim());
    });
  });
}

/**
 * Stream a single prompt to the `/code` endpoint (no tools, just text generation)
 * and collect the full response as a string.
 *
 * @param client - The Majestix API client.
 * @param prompt - The user message to send.
 * @param signal - Optional AbortSignal.
 * @returns The full response text.
 */
async function complete(
  client: MajestixClient,
  prompt: string,
  signal?: AbortSignal
): Promise<string> {
  const config = vscode.workspace.getConfiguration("majestix");
  const model = config.get<string>("defaultModel", "") || undefined;

  let text = "";
  for await (const event of client.codeStream(
    {
      messages: [{ role: "user", content: prompt }],
      model,
      tools: [],
      max_tokens: 1024,
    },
    signal
  )) {
    if (event.type === "text") { text += event.content; }
    if (event.type === "done") { break; }
    if (event.type === "error") { throw new Error(event.detail); }
  }
  return text.trim();
}

/**
 * Registers `majestix.commitMessage` — reads the staged diff and generates a conventional
 * commit message, then inserts it directly into the Source Control input box.
 *
 * @param client - The Majestix API client.
 * @returns A disposable for the registered command.
 */
export function registerCommitMessageCommand(client: MajestixClient): vscode.Disposable {
  return vscode.commands.registerCommand("majestix.commitMessage", async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined) {
      void vscode.window.showErrorMessage("Majestix AI: No workspace folder open.");
      return;
    }
    const cwd = folders[0].uri.fsPath;

    const stagedDiff = await runGit(["diff", "--staged"], cwd);
    const stagedStat = await runGit(["diff", "--staged", "--stat"], cwd);

    if (stagedDiff.length === 0) {
      void vscode.window.showWarningMessage(
        "Majestix AI: No staged changes. Stage some files first (git add)."
      );
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Majestix AI: Generating commit message…", cancellable: false },
      async () => {
        const diffPreview = stagedDiff.length > 8_000
          ? stagedDiff.slice(0, 8_000) + "\n[diff truncated]"
          : stagedDiff;

        const prompt =
          "Generate a concise git commit message for the following staged changes.\n\n" +
          "Rules:\n" +
          "- Use conventional commits format: type(scope): description\n" +
          "- First line must be \u226472 characters\n" +
          "- Optional body after a blank line explaining the \"why\" (not the \"what\")\n" +
          "- Do NOT include any explanation or markdown \u2014 output only the commit message text\n\n" +
          `Stat summary:\n${stagedStat}\n\n` +
          `Diff:\n\`\`\`diff\n${diffPreview}\n\`\`\``;

        try {
          const message = await complete(client, prompt);
          if (message.length === 0) {
            void vscode.window.showErrorMessage("Majestix AI: Could not generate commit message.");
            return;
          }

          // Write into the Git SCM input box
          const gitExtension = vscode.extensions.getExtension("vscode.git");
          if (gitExtension !== undefined) {
            const git = gitExtension.exports as { getAPI: (version: number) => { repositories: { inputBox: { value: string } }[] } };
            const api = git.getAPI(1);
            if (api.repositories.length > 0) {
              api.repositories[0].inputBox.value = message;
              void vscode.window.showInformationMessage("Majestix AI: Commit message generated.");
              return;
            }
          }

          // Fallback: copy to clipboard
          await vscode.env.clipboard.writeText(message);
          void vscode.window.showInformationMessage(
            "Majestix AI: Commit message copied to clipboard (Git extension not available)."
          );
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Majestix AI: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    );
  });
}

/**
 * Registers `majestix.prDescription` — reads the git log and diff between the current
 * branch and main/master, generates a PR title and description, then opens it in a
 * new editor so the user can review and copy it.
 *
 * @param client - The Majestix API client.
 * @returns A disposable for the registered command.
 */
export function registerPrDescriptionCommand(client: MajestixClient): vscode.Disposable {
  return vscode.commands.registerCommand("majestix.prDescription", async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined) {
      void vscode.window.showErrorMessage("Majestix AI: No workspace folder open.");
      return;
    }
    const cwd = folders[0].uri.fsPath;

    // Detect base branch (main or master)
    const branches = await runGit(["branch", "-a"], cwd);
    const baseBranch = branches.includes("main") ? "main" : "master";

    const log = await runGit(["log", `${baseBranch}..HEAD`, "--oneline"], cwd);
    const diffStat = await runGit(["diff", `${baseBranch}...HEAD`, "--stat"], cwd);
    const diff = await runGit(["diff", `${baseBranch}...HEAD`], cwd);

    if (log.length === 0) {
      void vscode.window.showWarningMessage(
        `Majestix AI: No commits ahead of ${baseBranch}.`
      );
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Majestix AI: Generating PR description…", cancellable: false },
      async () => {
        const diffPreview = diff.length > 10_000 ? diff.slice(0, 10_000) + "\n[diff truncated]" : diff;

        const prompt =
          "Generate a pull request title and description for the following changes.\n\n" +
          "Output ONLY the PR text, no explanation. Format:\n\n" +
          "## Title\n<concise title \u226470 chars>\n\n" +
          "## Description\n<markdown body with: Summary bullets, Changes bullets, Test plan>\n\n" +
          `Commits:\n${log}\n\n` +
          `Diff stat:\n${diffStat}\n\n` +
          `Diff (preview):\n\`\`\`diff\n${diffPreview}\n\`\`\``;

        try {
          const description = await complete(client, prompt);
          if (description.length === 0) {
            void vscode.window.showErrorMessage("Majestix AI: Could not generate PR description.");
            return;
          }

          // Open in a new untitled editor
          const doc = await vscode.workspace.openTextDocument({
            language: "markdown",
            content: description,
          });
          await vscode.window.showTextDocument(doc, { preview: false });
          void vscode.window.showInformationMessage("Majestix AI: PR description generated. Review and copy.");
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Majestix AI: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    );
  });
}
