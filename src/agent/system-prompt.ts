import { exec } from "child_process";
import * as os from "os";
import * as vscode from "vscode";

import { getRecentlyEditedFiles } from "../context/active-file";
import { trackEvent } from "../util/telemetry";

/**
 * Build the system prompt for the agent, including identity, rules, and environment context.
 *
 * @param mode - The agent mode ("code", "architect", or "ask").
 * @param environmentDetails - Pre-collected environment details string to embed.
 * @param projectRules - Optional custom project rules from .majestix-rules file.
 * @returns The full system prompt string for the agent.
 */
export function buildSystemPrompt(
  mode: string,
  environmentDetails: string,
  projectRules?: string
): string {
  const sections: string[] = [];

  // Identity
  sections.push(`You are Majestix AI, a professional coding assistant running inside VS Code.

You have access to tools that let you interact with the user's workspace. Use these tools to accomplish the user's task autonomously. You can read files, create or modify files, execute terminal commands, and search across the codebase.

CRITICAL: You MUST invoke tools directly — never print tool commands, syntax, or usage examples as text. When you need to read a file, call the read_file tool. When you need to edit a file, call the edit_file tool. Do not describe what tool you would use — just use it. The user cannot run tool commands from your text output; only actual tool invocations work.

IMPORTANT: Use ONLY the tool names provided in the tool definitions below. Do NOT use tool names from other systems (e.g. str_replace_editor, bash, create, view). The correct tool names are: read_file, write_to_file, edit_file, apply_patch, execute_command, search_files, list_files, attempt_completion.

When calling tools, use EXACTLY these parameter names:
- write_to_file: {"path": "relative/path/file.ts", "content": "full file content"}
- edit_file: {"path": "relative/path/file.ts", "edits": [{"old_text": "exact text to find", "new_text": "replacement text"}]}
- read_file: {"path": "relative/path/file.ts"}
- execute_command: {"command": "ls -la", "description": "list files"}
- apply_patch: {"patch": "*** Begin Patch\n..."}

Do NOT use alternative parameter names like "file", "filePath", "file_text", "cmd", or "args" — always use the names shown above.

IMPORTANT FOR FILE OPERATIONS:
- When reading a file with read_file, the output includes line numbers like "   42 | code here"
- When using edit_file, the old_text must be the RAW CODE ONLY — do NOT include the line numbers or the "| " prefix from read_file output
- Copy only the code portion from read_file output into old_text
- If you're unsure about the exact text to find, use read_file first to see the current content, then copy the exact code you want to replace`);

  // Mode-specific instructions
  if (mode === "code") {
    sections.push(`## Mode: Code
You are a hands-on coding agent. Read files, write code, run tests, and fix errors until the task is complete. Always verify your changes work before completing.`);
  } else if (mode === "architect") {
    sections.push(`## Mode: Architect
You are a software architect focused on analysis, planning, and documentation.

Tools available to you in this mode:
- read_file — read any file in the workspace
- search_files — search across the codebase
- list_files — list directory contents
- write_plan — create or update Markdown (.md) planning documents ONLY
- attempt_completion — signal task completion

You MUST NOT attempt to create or modify source code files (.ts, .js, .py, .json, etc.).
You CAN use write_plan to produce .md planning documents, architecture notes, task lists, and specs.
If asked to modify source code, explain the change needed in a plan document instead.`);
  } else if (mode === "ask") {
    sections.push(`## Mode: Ask
Answer the user's question about their codebase. Read files and search as needed to provide accurate answers. Do not create or modify any files.`);
  } else if (mode === "askonwrite") {
    sections.push(`## Mode: Ask + Write
Answer questions AND make targeted code changes when asked. You have full read and write access.
All write/edit operations require user approval before executing.
Use this mode when you want to ask questions and make small edits in the same session without switching modes.`);
  }

  // Rules
  sections.push(`## Rules
- Always read relevant files before making changes — understand before you modify
- When writing files, provide the COMPLETE file content — no placeholders or omissions
- If a command fails, read the error output and fix the issue — don't just report it
- When done, use attempt_completion to summarize what you accomplished
- Be concise in your explanations — prefer showing code over describing it
- If you create or modify files, verify the changes work (run tests/build if applicable)
- When using edit_file, the old_text must match the file EXACTLY — do not include line numbers or prefixes from read_file output. Copy the raw code only.
- If edit_file fails with "old_text not found", re-read the file to get the current content, then retry with the exact text. Do not guess or repeat the same failed edit.
- If edit_file keeps failing, try apply_patch instead — it uses diff format with context lines and is more forgiving.
- Work through tasks step by step. Read first, plan your changes, then execute. Do not ask the user what to do — take action autonomously.`);

  // Custom project rules
  if (projectRules !== undefined && projectRules.length > 0) {
    sections.push(`## Project Rules
${projectRules}`);
  }

  // Environment
  sections.push(`## Environment Details
${environmentDetails}`);

  return sections.join("\n\n");
}

/**
 * Collect environment details: OS, workspace info, open files, git status.
 *
 * @returns A multi-line string summarizing the current VS Code environment.
 */
export async function getEnvironmentDetails(): Promise<string> {
  const parts: string[] = [];

  // OS info
  parts.push(`- OS: ${os.platform()} ${os.arch()}`);
  parts.push(`- Shell: ${vscode.env.shell.length > 0 ? vscode.env.shell : "unknown"}`);

  // Workspace info
  const folders = vscode.workspace.workspaceFolders;
  if (folders !== undefined && folders.length > 0) {
    parts.push(`- Workspace: ${folders[0].name}`);
    parts.push(`- Workspace root: ${folders[0].uri.fsPath}`);
  }

  // Active file
  const editor = vscode.window.activeTextEditor;
  if (editor !== undefined) {
    const relPath = vscode.workspace.asRelativePath(editor.document.uri);
    parts.push(`- Active file: ${relPath} (${editor.document.languageId})`);
  }

  // Open tabs — shows the user's working set
  const openTabs = vscode.window.tabGroups.all
    .flatMap(group => group.tabs)
    .filter(tab => tab.input instanceof vscode.TabInputText)
    .map(tab => vscode.workspace.asRelativePath((tab.input as vscode.TabInputText).uri))
    .filter((tabPath, i, arr) => arr.indexOf(tabPath) === i) // dedupe
    .slice(0, 15);
  if (openTabs.length > 0) {
    parts.push(`- Open tabs (${String(openTabs.length)}): ${openTabs.join(", ")}`);
  }

  // Recently edited files (last 10 minutes)
  const recentEdits = getRecentlyEditedFiles();
  if (recentEdits.length > 0) {
    parts.push(`- Recently edited: ${recentEdits.join(", ")}`);
  }

  // Workspace structure — compact top-level listing so the agent understands the project layout
  if (folders !== undefined && folders.length > 0) {
    try {
      const rootUri = folders[0].uri;
      const entries = await vscode.workspace.fs.readDirectory(rootUri);
      const IGNORED = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", ".next", "coverage", ".nyc_output"]);
      const topLevel = entries
        .filter(([name]) => !IGNORED.has(name))
        .sort((a, b) => {
          // Directories first, then files
          if (a[1] !== b[1]) {return b[1] === vscode.FileType.Directory ? 1 : -1;}
          return a[0].localeCompare(b[0]);
        })
        .slice(0, 30)
        .map(([name, type]) => type === vscode.FileType.Directory ? `${name}/` : name);
      if (topLevel.length > 0) {
        parts.push(`- Workspace structure:\n  ${topLevel.join("\n  ")}`);
      }
    } catch { /* ignore */ }
  }

  // Git context
  const wsFolders = vscode.workspace.workspaceFolders;
  if (wsFolders !== undefined) {
    const cwd = wsFolders[0].uri.fsPath;
    const gitBranch = await runShellQuiet("git rev-parse --abbrev-ref HEAD", cwd);
    if (gitBranch.length > 0) {
      parts.push(`- Git branch: ${gitBranch}`);
    }
    const gitStatus = await runShellQuiet("git status --porcelain --short", cwd);
    if (gitStatus.length > 0) {
      const lines = gitStatus.split("\n").slice(0, 15);
      parts.push(`- Git status:\n${lines.join("\n")}${lines.length >= 15 ? "\n  ... (truncated)" : ""}`);
    }
    // Staged diff summary — helps the agent understand what the user is about to commit
    const gitDiffStat = await runShellQuiet("git diff --cached --stat", cwd);
    if (gitDiffStat.length > 0) {
      parts.push(`- Staged changes:\n${gitDiffStat}`);
    }
  }

  return parts.join("\n");
}

/**
 * Runs a shell command quietly, returning stdout or an empty string on failure.
 * Logs failures to telemetry so the agent doesn't silently assume no git repo.
 *
 * @param command - The shell command to execute.
 * @param cwd - The working directory for the command.
 * @returns The trimmed stdout output, or an empty string if the command fails.
 */
function runShellQuiet(command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 5000, maxBuffer: 8192 }, (err, stdout, stderr) => {
      if (err !== null) {
        const stderrStr = typeof stderr === "string" ? stderr : "";
        const msg = err.message || stderrStr.trim() || "unknown error";
        trackEvent("shell.quiet_error", { command: command.split(" ")[0], error: msg.slice(0, 200) });
        resolve("");
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Read project rules from .majestix-rules or .majestix/rules file.
 *
 * @returns The trimmed project rules string if found, or undefined if no rules file exists.
 */
export async function loadProjectRules(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (folders === undefined) {return undefined;}

  const root = folders[0].uri;
  const candidates = [".majestix-rules", ".majestix/rules", ".clinerules"];

  for (const name of candidates) {
    try {
      const uri = vscode.Uri.joinPath(root, name);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(bytes);
      if (text.trim().length > 0) {return text.trim();}
    } catch {
      // file doesn't exist, try next
    }
  }

  return undefined;
}
