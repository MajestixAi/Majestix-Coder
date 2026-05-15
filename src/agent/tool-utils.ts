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
    const newLines = newContent.split("\n").length;
    if (oldContent.length === 0) {
      return `New file: ${String(newLines)} lines`;
    }
    // Simple summary — no expensive line-by-line diff loop.
    // The model provides complete new content for write_to_file;
    // a detailed diff is unnecessary and causes 20+ second freezes on large files.
    const oldLines = oldContent.split("\n").length;
    const added = newLines - oldLines;
    const desc = added >= 0 ? `+${String(added)} lines` : `${String(added)} lines`;
    return `Overwrite ${filePath} (${String(oldLines)} → ${String(newLines)} lines, ${desc})`;
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
/**
 * Normalizes tool input params from aliased/foreign model schemas to our canonical schema.
 * Handles str_replace_editor, bash, view aliases, and many Gemini/OpenAI variations.
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
  // === str_replace_editor (SWE-bench / OpenHands) ===
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

  // === execute_command normalization ===
  if (resolvedName === "execute_command") {
    if (input.cmd !== undefined && input.command === undefined) {
      input.command = input.cmd;
      delete input.cmd;
    }
    if (input.code !== undefined && input.command === undefined) {
      input.command = input.code;
      delete input.code;
    }
    if (input.script !== undefined && input.command === undefined) {
      input.command = input.script;
      delete input.script;
    }
    if (input.terminal !== undefined && input.command === undefined) {
      input.command = input.terminal;
      delete input.terminal;
    }
    if (input.shell !== undefined && input.command === undefined) {
      input.command = input.shell;
      delete input.shell;
    }
    if (input.args !== undefined && input.command === undefined) {
      // Some models send args as a string or array
      input.command = Array.isArray(input.args) ? input.args.join(" ") : JSON.stringify(input.args);
      delete input.args;
    }
    return;
  }

  // === read_file normalization ===
  if (resolvedName === "read_file") {
    // Path variations — try all common alternatives
    if (input.file !== undefined && input.path === undefined) { input.path = input.file; delete input.file; }
    else if (input.file_path !== undefined && input.path === undefined) { input.path = input.file_path; delete input.file_path; }
    else if (input.filepath !== undefined && input.path === undefined) { input.path = input.filepath; delete input.filepath; }
    else if (input.filename !== undefined && input.path === undefined) { input.path = input.filename; delete input.filename; }
    else if (input.file_name !== undefined && input.path === undefined) { input.path = input.file_name; delete input.file_name; }
    else if (input.filePath !== undefined && input.path === undefined) { input.path = input.filePath; delete input.filePath; }
    else if (input.fileName !== undefined && input.path === undefined) { input.path = input.fileName; delete input.fileName; }
    // Line range variations
    if (input.startLine !== undefined && input.start_line === undefined) { input.start_line = input.startLine; delete input.startLine; }
    if (input.endLine !== undefined && input.end_line === undefined) { input.end_line = input.endLine; delete input.endLine; }
    if (input.line_start !== undefined && input.start_line === undefined) { input.start_line = input.line_start; delete input.line_start; }
    if (input.line_end !== undefined && input.end_line === undefined) { input.end_line = input.line_end; delete input.line_end; }
    if (input.from_line !== undefined && input.start_line === undefined) { input.start_line = input.from_line; delete input.from_line; }
    if (input.to_line !== undefined && input.end_line === undefined) { input.end_line = input.to_line; delete input.to_line; }
    if (Array.isArray(input.view_range) && input.view_range.length >= 2) {
      if (input.start_line === undefined) { input.start_line = input.view_range[0]; }
      if (input.end_line === undefined) { input.end_line = input.view_range[1]; }
      delete input.view_range;
    }
    if (input.offset !== undefined && input.start_line === undefined) { input.start_line = input.offset; delete input.offset; }
    return;
  }

  // === write_to_file normalization ===
  if (resolvedName === "write_to_file") {
    // Path variations
    if (input.file !== undefined && input.path === undefined) { input.path = input.file; delete input.file; }
    else if (input.file_path !== undefined && input.path === undefined) { input.path = input.file_path; delete input.file_path; }
    else if (input.filepath !== undefined && input.path === undefined) { input.path = input.filepath; delete input.filepath; }
    else if (input.filename !== undefined && input.path === undefined) { input.path = input.filename; delete input.filename; }
    else if (input.file_name !== undefined && input.path === undefined) { input.path = input.file_name; delete input.file_name; }
    else if (input.filePath !== undefined && input.path === undefined) { input.path = input.filePath; delete input.filePath; }
    else if (input.fileName !== undefined && input.path === undefined) { input.path = input.fileName; delete input.fileName; }
    // Content variations
    if (input.file_text !== undefined && input.content === undefined) { input.content = input.file_text; delete input.file_text; }
    else if (input.text !== undefined && input.content === undefined) { input.content = input.text; delete input.text; }
    else if (input.data !== undefined && input.content === undefined) { input.content = input.data; delete input.data; }
    else if (input.body !== undefined && input.content === undefined) { input.content = input.body; delete input.body; }
    else if (input.source !== undefined && input.content === undefined) { input.content = input.source; delete input.source; }
    else if (input.code !== undefined && input.content === undefined) { input.content = input.code; delete input.code; }
    else if (input.file_content !== undefined && input.content === undefined) { input.content = input.file_content; delete input.file_content; }
    else if (input.fileContent !== undefined && input.content === undefined) { input.content = input.fileContent; delete input.fileContent; }
    return;
  }

  // === edit_file normalization ===
  if (resolvedName === "edit_file") {
    // Path variations
    if (input.file !== undefined && input.path === undefined) { input.path = input.file; delete input.file; }
    else if (input.file_path !== undefined && input.path === undefined) { input.path = input.file_path; delete input.file_path; }
    else if (input.filepath !== undefined && input.path === undefined) { input.path = input.filepath; delete input.filepath; }
    else if (input.filename !== undefined && input.path === undefined) { input.path = input.filename; delete input.filename; }
    else if (input.file_name !== undefined && input.path === undefined) { input.path = input.file_name; delete input.file_name; }
    else if (input.filePath !== undefined && input.path === undefined) { input.path = input.filePath; delete input.filePath; }
    else if (input.fileName !== undefined && input.path === undefined) { input.path = input.fileName; delete input.fileName; }
    // Edits variations — many models use different structures
    if (input.edit !== undefined && input.edits === undefined) { input.edits = input.edit; delete input.edit; }
    else if (input.changes !== undefined && input.edits === undefined) { input.edits = input.changes; delete input.changes; }
    else if (input.replacements !== undefined && input.edits === undefined) { input.edits = input.replacements; delete input.replacements; }
    else if (input.modifications !== undefined && input.edits === undefined) { input.edits = input.modifications; delete input.modifications; }
    else if (input.diffs !== undefined && input.edits === undefined) { input.edits = input.diffs; delete input.diffs; }
    // Normalize individual edit fields (old_text/new_text variations)
    if (Array.isArray(input.edits)) {
      input.edits = input.edits.map((edit: Record<string, unknown>) => {
        const normalized: Record<string, unknown> = { ...edit };
        // old_text variations
        if (normalized.oldText !== undefined && normalized.old_text === undefined) { normalized.old_text = normalized.oldText; delete normalized.oldText; }
        else if (normalized.old_str !== undefined && normalized.old_text === undefined) { normalized.old_text = normalized.old_str; delete normalized.old_str; }
        else if (normalized.oldStr !== undefined && normalized.old_text === undefined) { normalized.old_text = normalized.oldStr; delete normalized.oldStr; }
        else if (normalized.search !== undefined && normalized.old_text === undefined) { normalized.old_text = normalized.search; delete normalized.search; }
        else if (normalized.find !== undefined && normalized.old_text === undefined) { normalized.old_text = normalized.find; delete normalized.find; }
        else if (normalized.original !== undefined && normalized.old_text === undefined) { normalized.old_text = normalized.original; delete normalized.original; }
        else if (normalized.before !== undefined && normalized.old_text === undefined) { normalized.old_text = normalized.before; delete normalized.before; }
        else if (normalized.match !== undefined && normalized.old_text === undefined) { normalized.old_text = normalized.match; delete normalized.match; }
        // new_text variations
        if (normalized.newText !== undefined && normalized.new_text === undefined) { normalized.new_text = normalized.newText; delete normalized.newText; }
        else if (normalized.new_str !== undefined && normalized.new_text === undefined) { normalized.new_text = normalized.new_str; delete normalized.new_str; }
        else if (normalized.newStr !== undefined && normalized.new_text === undefined) { normalized.new_text = normalized.newStr; delete normalized.newStr; }
        else if (normalized.replace !== undefined && normalized.new_text === undefined) { normalized.new_text = normalized.replace; delete normalized.replace; }
        else if (normalized.replacement !== undefined && normalized.new_text === undefined) { normalized.new_text = normalized.replacement; delete normalized.replacement; }
        else if (normalized.updated !== undefined && normalized.new_text === undefined) { normalized.new_text = normalized.updated; delete normalized.updated; }
        else if (normalized.after !== undefined && normalized.new_text === undefined) { normalized.new_text = normalized.after; delete normalized.after; }
        else if (normalized.target !== undefined && normalized.new_text === undefined) { normalized.new_text = normalized.target; delete normalized.target; }
        return normalized;
      });
    } else if (typeof input.edits === "object" && input.edits !== null) {
      // Single edit object — normalize its fields
      const edit = input.edits as Record<string, unknown>;
      if (edit.oldText !== undefined && edit.old_text === undefined) { edit.old_text = edit.oldText; delete edit.oldText; }
      else if (edit.old_str !== undefined && edit.old_text === undefined) { edit.old_text = edit.old_str; delete edit.old_str; }
      else if (edit.oldStr !== undefined && edit.old_text === undefined) { edit.old_text = edit.oldStr; delete edit.oldStr; }
      else if (edit.search !== undefined && edit.old_text === undefined) { edit.old_text = edit.search; delete edit.search; }
      else if (edit.find !== undefined && edit.old_text === undefined) { edit.old_text = edit.find; delete edit.find; }
      else if (edit.original !== undefined && edit.old_text === undefined) { edit.old_text = edit.original; delete edit.original; }
      else if (edit.before !== undefined && edit.old_text === undefined) { edit.old_text = edit.before; delete edit.before; }
      else if (edit.match !== undefined && edit.old_text === undefined) { edit.old_text = edit.match; delete edit.match; }
      if (edit.newText !== undefined && edit.new_text === undefined) { edit.new_text = edit.newText; delete edit.newText; }
      else if (edit.new_str !== undefined && edit.new_text === undefined) { edit.new_text = edit.new_str; delete edit.new_str; }
      else if (edit.newStr !== undefined && edit.new_text === undefined) { edit.new_text = edit.newStr; delete edit.newStr; }
      else if (edit.replace !== undefined && edit.new_text === undefined) { edit.new_text = edit.replace; delete edit.replace; }
      else if (edit.replacement !== undefined && edit.new_text === undefined) { edit.new_text = edit.replacement; delete edit.replacement; }
      else if (edit.updated !== undefined && edit.new_text === undefined) { edit.new_text = edit.updated; delete edit.updated; }
      else if (edit.after !== undefined && edit.new_text === undefined) { edit.new_text = edit.after; delete edit.after; }
      else if (edit.target !== undefined && edit.new_text === undefined) { edit.new_text = edit.target; delete edit.target; }
    }
    // Flat old_text/new_text at top level
    if (input.old_str !== undefined && input.old_text === undefined) { input.old_text = input.old_str; delete input.old_str; }
    if (input.new_str !== undefined && input.new_text === undefined) { input.new_text = input.new_str; delete input.new_str; }
    if (input.search !== undefined && input.old_text === undefined) { input.old_text = input.search; delete input.search; }
    if (input.replace !== undefined && input.new_text === undefined) { input.new_text = input.replace; delete input.replace; }
    return;
  }

  // === apply_patch normalization ===
  if (resolvedName === "apply_patch") {
    if (input.diff !== undefined && input.patch === undefined) { input.patch = input.diff; delete input.diff; }
    else if (input.patch_content !== undefined && input.patch === undefined) { input.patch = input.patch_content; delete input.patch_content; }
    else if (input.patchContent !== undefined && input.patch === undefined) { input.patch = input.patchContent; delete input.patchContent; }
    else if (input.diff_content !== undefined && input.patch === undefined) { input.patch = input.diff_content; delete input.diff_content; }
    else if (input.diffContent !== undefined && input.patch === undefined) { input.patch = input.diffContent; delete input.diffContent; }
    else if (input.input !== undefined && input.patch === undefined) { input.patch = input.input; delete input.input; }
    return;
  }

  // === attempt_completion normalization ===
  if (resolvedName === "attempt_completion") {
    if (input.summary !== undefined && input.result === undefined) { input.result = input.summary; delete input.summary; }
    else if (input.message !== undefined && input.result === undefined) { input.result = input.message; delete input.message; }
    else if (input.output !== undefined && input.result === undefined) { input.result = input.output; delete input.output; }
    else if (input.response !== undefined && input.result === undefined) { input.result = input.response; delete input.response; }
    else if (input.answer !== undefined && input.result === undefined) { input.result = input.answer; delete input.answer; }
    return;
  }

  // === search_files normalization ===
  if (resolvedName === "search_files") {
    if (input.directory !== undefined && input.path === undefined) { input.path = input.directory; delete input.directory; }
    else if (input.dir !== undefined && input.path === undefined) { input.path = input.dir; delete input.dir; }
    else if (input.folder !== undefined && input.path === undefined) { input.path = input.folder; delete input.folder; }
    else if (input.root !== undefined && input.path === undefined) { input.path = input.root; delete input.root; }
    if (input.regex !== undefined && input.pattern === undefined) { input.pattern = input.regex; delete input.regex; }
    else if (input.query !== undefined && input.pattern === undefined) { input.pattern = input.query; delete input.query; }
    else if (input.search !== undefined && input.pattern === undefined) { input.pattern = input.search; delete input.search; }
    else if (input.searchTerm !== undefined && input.pattern === undefined) { input.pattern = input.searchTerm; delete input.searchTerm; }
    return;
  }

  // === list_files normalization ===
  if (resolvedName === "list_files") {
    if (input.directory !== undefined && input.path === undefined) { input.path = input.directory; delete input.directory; }
    else if (input.dir !== undefined && input.path === undefined) { input.path = input.dir; delete input.dir; }
    else if (input.folder !== undefined && input.path === undefined) { input.path = input.folder; delete input.folder; }
    return;
  }
}

/**
 * Universal tool input normalizer — runs for ALL tools regardless of alias status.
 * Catches parameter name variations that models (especially Gemini/OpenAI) frequently emit.
 * This is a safety net that runs after alias-specific normalization.
 *
 * @param toolName - The canonical tool name.
 * @param input - The tool input object to normalize in place.
 */
export function normalizeToolInput(
  toolName: string,
  input: Record<string, unknown>
): void {
  // Universal path normalization — all file tools
  const fileTools = new Set(["read_file", "write_to_file", "edit_file", "apply_patch", "list_files"]);
  if (fileTools.has(toolName) && input.path === undefined) {
    if (input.file !== undefined) { input.path = input.file; delete input.file; }
    else if (input.file_path !== undefined) { input.path = input.file_path; delete input.file_path; }
    else if (input.filepath !== undefined) { input.path = input.filepath; delete input.filepath; }
    else if (input.filename !== undefined) { input.path = input.filename; delete input.filename; }
    else if (input.file_name !== undefined) { input.path = input.file_name; delete input.file_name; }
    else if (input.filePath !== undefined) { input.path = input.filePath; delete input.filePath; }
    else if (input.fileName !== undefined) { input.path = input.fileName; delete input.fileName; }
  }

  // Universal content normalization — write tools
  const writeTools = new Set(["write_to_file"]);
  if (writeTools.has(toolName) && input.content === undefined) {
    if (input.file_text !== undefined) { input.content = input.file_text; delete input.file_text; }
    else if (input.text !== undefined) { input.content = input.text; delete input.text; }
    else if (input.data !== undefined) { input.content = input.data; delete input.data; }
    else if (input.body !== undefined) { input.content = input.body; delete input.body; }
    else if (input.source !== undefined) { input.content = input.source; delete input.source; }
    else if (input.code !== undefined) { input.content = input.code; delete input.code; }
    else if (input.file_content !== undefined) { input.content = input.file_content; delete input.file_content; }
    else if (input.fileContent !== undefined) { input.content = input.fileContent; delete input.fileContent; }
  }

  // Universal command normalization
  if (toolName === "execute_command" && input.command === undefined) {
    if (input.cmd !== undefined) { input.command = input.cmd; delete input.cmd; }
    else if (input.code !== undefined) { input.command = input.code; delete input.code; }
    else if (input.script !== undefined) { input.command = input.script; delete input.script; }
    else if (input.terminal !== undefined) { input.command = input.terminal; delete input.terminal; }
    else if (input.shell !== undefined) { input.command = input.shell; delete input.shell; }
    else if (input.args !== undefined) {
      input.command = Array.isArray(input.args) ? (input.args as string[]).join(" ") : JSON.stringify(input.args);
      delete input.args;
    }
  }

  // Universal patch normalization
  if (toolName === "apply_patch" && input.patch === undefined) {
    if (input.diff !== undefined) { input.patch = input.diff; delete input.diff; }
    else if (input.patch_content !== undefined) { input.patch = input.patch_content; delete input.patch_content; }
    else if (input.patchContent !== undefined) { input.patch = input.patchContent; delete input.patchContent; }
    else if (input.diff_content !== undefined) { input.patch = input.diff_content; delete input.diff_content; }
    else if (input.diffContent !== undefined) { input.patch = input.diffContent; delete input.diffContent; }
    else if (input.input !== undefined) { input.patch = input.input; delete input.input; }
  }

  // Universal completion normalization
  if (toolName === "attempt_completion" && input.result === undefined) {
    if (input.summary !== undefined) { input.result = input.summary; delete input.summary; }
    else if (input.message !== undefined) { input.result = input.message; delete input.message; }
    else if (input.output !== undefined) { input.result = input.output; delete input.output; }
    else if (input.response !== undefined) { input.result = input.response; delete input.response; }
    else if (input.answer !== undefined) { input.result = input.answer; delete input.answer; }
  }
}
