// ---------------------------------------------------------------------------
// Tool utilities — approval UI helpers and aliased-input normalization
// ---------------------------------------------------------------------------

import * as vscode from "vscode";
import { resolveWorkspacePath } from "../util/path-safety";

/**
 * Returns a short human-readable description of a tool call for the approval dialog.
 *
 * @param name - The tool name (e.g. `"write_to_file"`).
 * @param input - The tool input parameters.
 * @returns A short string describing the operation for display in the approval UI.
 */
export function formatToolDescription(
  name: string,
  input: Record<string, unknown>
): string {
  switch (name) {
    case "write_to_file":
      return `Write to ${String(input.path)}`;
    case "edit_file":
      return `Edit ${String(input.path)}`;
    case "apply_patch": {
      const patch = typeof input.patch === "string" ? input.patch : "";
      const files = [...patch.matchAll(/\*\*\* (?:Add|Update|Delete) File: (.+)/g)].map(m => m[1].trim());
      return files.length > 0 ? `Patch ${files.join(", ")}` : "Apply patch";
    }
    case "execute_command": {
      const desc = typeof input.description === "string" && input.description.length > 0
        ? ` — ${input.description}`
        : "";
      return `Run: ${String(input.command)}${desc}`;
    }
    default:
      return `${name}(${JSON.stringify(input).slice(0, 100)})`;
  }
}

/**
 * Computes a compact diff summary for the approval card (write_to_file, edit_file, apply_patch).
 *
 * @param workspaceRoot - The workspace root URI used to resolve relative file paths.
 * @param toolName - The name of the tool being invoked (determines diff strategy).
 * @param input - The tool input parameters containing path, content, edits, or patch.
 * @returns A compact diff summary string, or undefined if one cannot be computed.
 */
export async function computeFileDiffSummary(
  workspaceRoot: vscode.Uri,
  toolName: string,
  input: Record<string, unknown>
): Promise<string | undefined> {
  const filePath = input.path as string | undefined;
  if (filePath === undefined) { return undefined; }

  let uri: vscode.Uri;
  try {
    uri = resolveWorkspacePath(workspaceRoot, filePath);
  } catch {
    return undefined;
  }

  let oldContent = "";
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    oldContent = new TextDecoder().decode(bytes);
  } catch {
    // New file — oldContent stays empty
  }

  if (toolName === "write_to_file") {
    const newContent = input.content as string | undefined;
    if (newContent === undefined) { return undefined; }
    if (oldContent.length === 0) {
      return `New file: ${String(newContent.split("\n").length)} lines`;
    }
    return buildCompactDiff(oldContent, newContent, filePath);
  }

  if (toolName === "edit_file") {
    const edits = input.edits;
    if (!Array.isArray(edits)) { return undefined; }
    const summaries: string[] = [];
    for (const edit of edits.slice(0, 3) as { old_text?: string; new_text?: string }[]) {
      if (typeof edit.old_text === "string") {
        const oldLines = edit.old_text.split("\n").length;
        const newLines = (edit.new_text ?? "").split("\n").length;
        summaries.push(`${String(oldLines)}→${String(newLines)} lines`);
      }
    }
    const suffix = edits.length > 3 ? ` (+${String(edits.length - 3)} more)` : "";
    return `${String(edits.length)} edit(s): ${summaries.join(", ")}${suffix}`;
  }

  if (toolName === "apply_patch") {
    const patch = typeof input.patch === "string" ? input.patch : "";
    const ops = [...patch.matchAll(/\*\*\* (Add|Update|Delete) File: (.+)/g)]
      .map(m => `${m[1]} ${m[2].trim()}`);
    if (ops.length === 0) { return undefined; }
    return `${String(ops.length)} file operation(s):\n${ops.slice(0, 5).join("\n")}`;
  }

  return undefined;
}

/**
 * Builds a compact line-level diff string between old and new file content.
 *
 * @param oldContent - The existing file content before the change.
 * @param newContent - The new file content after the change.
 * @param filePath - The file path shown in the diff header.
 * @returns A compact diff summary string showing changed lines.
 */
function buildCompactDiff(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const diffLines: string[] = [];
  const maxDiffLines = 12;
  let changeCount = 0;
  const minLen = Math.min(oldLines.length, newLines.length);

  for (let i = 0; i < minLen && diffLines.length < maxDiffLines; i++) {
    if (oldLines[i] !== newLines[i]) {
      changeCount++;
      diffLines.push(`-${String(i + 1)}: ${oldLines[i].slice(0, 80)}`);
      diffLines.push(`+${String(i + 1)}: ${newLines[i].slice(0, 80)}`);
    }
  }

  if (newLines.length > oldLines.length) {
    changeCount += newLines.length - oldLines.length;
    if (diffLines.length < maxDiffLines) {
      diffLines.push(`+${String(oldLines.length + 1)}..${String(newLines.length)}: (${String(newLines.length - oldLines.length)} new lines)`);
    }
  } else if (oldLines.length > newLines.length) {
    changeCount += oldLines.length - newLines.length;
    if (diffLines.length < maxDiffLines) {
      diffLines.push(`-${String(newLines.length + 1)}..${String(oldLines.length)}: (${String(oldLines.length - newLines.length)} removed lines)`);
    }
  }

  if (changeCount === 0) { return "No changes detected"; }
  const truncated = diffLines.length >= maxDiffLines ? "\n..." : "";
  return `${filePath}: ${String(changeCount)} change(s)\n${diffLines.join("\n")}${truncated}`;
}

/**
 * Normalizes tool input params from aliased/foreign model schemas to our canonical schema.
 * Handles str_replace_editor, bash, and view aliases.
 *
 * @param originalName - The tool name as emitted by the model (may be an alias).
 * @param resolvedName - The canonical tool name after alias resolution.
 * @param input - The tool input object to normalize in place.
 */
export function normalizeAliasedInput(
  originalName: string,
  resolvedName: string,
  input: Record<string, unknown>
): void {
  if (originalName === "str_replace_editor" || originalName === "str_replace_command") {
    if (input.file !== undefined && input.path === undefined) {
      input.path = input.file;
      delete input.file;
    }
    const subCommand = typeof input.command === "string" ? input.command : "";
    if (subCommand === "view") {
      if (Array.isArray(input.view_range) && input.view_range.length >= 2) {
        input.start_line = input.view_range[0];
        input.end_line = input.view_range[1];
        delete input.view_range;
      }
    } else if (subCommand === "create" || input.file_text !== undefined) {
      if (input.file_text !== undefined && input.content === undefined) {
        input.content = input.file_text;
        delete input.file_text;
      }
    } else {
      if (input.old_str !== undefined && input.old_text === undefined) {
        input.old_text = input.old_str;
        delete input.old_str;
      }
      if (input.new_str !== undefined && input.new_text === undefined) {
        input.new_text = input.new_str;
        delete input.new_str;
      }
      if (subCommand === "insert" && input.insert_line !== undefined && input.old_text === undefined) {
        input.old_text = "";
        input.new_text = input.new_text ?? "";
        input.insert_line_hint = input.insert_line;
        delete input.insert_line;
      }
    }
    if (subCommand.length > 0) { delete input.command; }
    return;
  }

  if (resolvedName === "execute_command") {
    if (input.cmd !== undefined && input.command === undefined) {
      input.command = input.cmd;
      delete input.cmd;
    }
    return;
  }

  if (resolvedName === "read_file") {
    if (input.file !== undefined && input.path === undefined) {
      input.path = input.file;
      delete input.file;
    }
    if (input.file_path !== undefined && input.path === undefined) {
      input.path = input.file_path;
      delete input.file_path;
    }
    return;
  }
}
