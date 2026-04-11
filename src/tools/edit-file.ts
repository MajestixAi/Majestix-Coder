import * as vscode from "vscode";

import {
  detectLineEnding,
  escapeDollarSigns,
  findNearbyContext,
  fuzzySearch,
  indentAwareReplace,
  normalizeLineEndings,
  restoreLineEndings,
  stripLineNumberPrefixes,
} from "./diff-match";
import { stashBackup } from "./file-backup";
import { resolveWorkspacePath } from "../util/path-safety";
import type {
  ToolContext,
  ToolHandler,
  ToolResult,
} from "./types";

export const editFileTool: ToolHandler = {
  definition: {
    name: "edit_file",
    description:
      "Make targeted edits to a file using search-and-replace blocks. " +
      "Each edit finds an exact text match and replaces it. " +
      "IMPORTANT: old_text must be the raw file content — do NOT include line numbers from read_file output. " +
      "This is more efficient than write_to_file for small changes to large files. " +
      "The user will see a diff and must approve.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root",
        },
        edits: {
          type: "array",
          description: "Array of search-and-replace edits",
          items: {
            type: "object",
            properties: {
              old_text: {
                type: "string",
                description: "Exact text to find in the file (raw code, no line numbers). Must match uniquely.",
              },
              new_text: {
                type: "string",
                description: "Text to replace it with",
              },
            },
            required: ["old_text", "new_text"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },

  requiresApproval: () => true,

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const filePath = input.path as string;

    // Normalize edits from various formats different models may send
    const edits = normalizeEditsInput(input);
    if (edits === null) {
      const editsType = typeof input.edits;
      const editsPreview = JSON.stringify(input.edits).slice(0, 200);
      return {
        tool_use_id: "",
        content:
          `Missing required parameter: edits (array of {old_text, new_text}). Received keys: ${Object.keys(input).join(", ")}. ` +
          `edits type: ${editsType}, value: ${editsPreview}. ` +
          "Expected format: edits: [{old_text: \"exact text to find\", new_text: \"replacement text\"}].",
        is_error: true,
      };
    }

    let uri: vscode.Uri;
    try {
      uri = resolveWorkspacePath(context.workspaceRoot, filePath);
    } catch (e: unknown) {
      return {
        tool_use_id: "",
        content: `Invalid path: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
      };
    }

    let rawContent: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      rawContent = new TextDecoder().decode(bytes);
    } catch {
      return {
        tool_use_id: "",
        content: `File not found: ${filePath}`,
        is_error: true,
      };
    }

    // Detect and preserve original line endings
    const originalLineEnding = detectLineEnding(rawContent);
    const content = normalizeLineEndings(rawContent);

    // Stash backup before modifying
    await stashBackup(uri);

    let modified = content;
    const applied: string[] = [];
    const failed: string[] = [];

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      if (typeof edit.old_text !== "string" || typeof edit.new_text !== "string") {
        failed.push(`Edit ${String(i + 1)}: invalid edit — old_text and new_text must be strings, got old_text=${typeof edit.old_text}, new_text=${typeof edit.new_text}`);
        continue;
      }
      const result = applyEdit(modified, edit.old_text, edit.new_text, i);
      if (result.success) {
        modified = result.content;
        applied.push(`Edit ${String(i + 1)}: applied${result.method !== "exact" ? ` (via ${result.method})` : ""}`);
      } else {
        failed.push(`Edit ${String(i + 1)}: ${result.error}`);
      }
    }

    if (applied.length === 0) {
      return {
        tool_use_id: "",
        content: `No edits could be applied to ${filePath}:\n${failed.join("\n")}`,
        is_error: true,
      };
    }

    // Restore original line endings and write
    const finalContent = restoreLineEndings(modified, originalLineEnding);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(finalContent));

    const summary = [...applied, ...failed].join("\n");
    const partialWarning = failed.length > 0
      ? `\n\n⚠️ ${String(failed.length)} edit(s) failed. Re-read the file with read_file to see its current state before retrying.`
      : "";
    return {
      tool_use_id: "",
      content: `Edited ${filePath}: ${String(applied.length)}/${String(edits.length)} edits applied\n${summary}${partialWarning}`,
      is_error: failed.length > 0 && applied.length === 0,
    };
  },
};

// ---------------------------------------------------------------------------
// Edit application with multi-level fallback
// ---------------------------------------------------------------------------

/** Result of attempting to apply a single edit. */
interface EditResult {
  success: boolean;
  content: string;
  method: string;
  error: string;
}

/**
 * Count non-overlapping occurrences of a substring.
 *
 * @param str - The string to search in.
 * @param substr - The substring to count.
 * @returns The count of non-overlapping occurrences.
 */
function countOccurrences(str: string, substr: string): number {
  if (substr === "") {return 0;}
  let count = 0;
  let pos = str.indexOf(substr);
  while (pos !== -1) {
    count++;
    pos = str.indexOf(substr, pos + substr.length);
  }
  return count;
}

/**
 * Literal string replace that handles $ in replacement (avoids regex substitution).
 *
 * @param str - The original string.
 * @param oldStr - The string to find.
 * @param newStr - The replacement string.
 * @returns The string with the first occurrence replaced.
 */
function safeLiteralReplace(str: string, oldStr: string, newStr: string): string {
  const idx = str.indexOf(oldStr);
  if (idx === -1) {return str;}
  return str.slice(0, idx) + newStr + str.slice(idx + oldStr.length);
}

/**
 * Escape a string for use in a regex.
 *
 * @param input - The string to escape.
 * @returns The escaped string safe for regex use.
 */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a regex that matches old_text with flexible whitespace.
 * Whitespace runs become `\s+` patterns; non-whitespace is literal.
 * Adapted from Kilo Code's EditFileTool.
 *
 * @param oldLF - The search text (LF-normalized).
 * @returns A global regex for whitespace-tolerant matching.
 */
function buildWhitespaceTolerantRegex(oldLF: string): RegExp {
  if (oldLF === "") {return /(?!)/g;}
  const parts = oldLF.match(/(\s+|\S+)/g) ?? [];
  const pattern = parts
    .map(part => {
      if (/^\s+$/.test(part)) {
        return part.includes("\n") ? "\\s+" : "[\\t ]+";
      }
      return escapeRegExp(part);
    })
    .join("");
  return new RegExp(pattern, "g");
}

/**
 * Build a regex that matches the tokens of old_text ignoring all whitespace.
 * Adapted from Kilo Code's EditFileTool.
 *
 * @param oldLF - The search text (LF-normalized).
 * @returns A global regex for token-based matching.
 */
function buildTokenRegex(oldLF: string): RegExp {
  const tokens = oldLF.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {return /(?!)/g;}
  const pattern = tokens.map(escapeRegExp).join("\\s+");
  return new RegExp(pattern, "g");
}

/**
 * Count matches of a global regex in a string.
 *
 * @param content - The string to search.
 * @param regex - The global regex to match.
 * @returns The count of matches.
 */
function countRegexMatches(content: string, regex: RegExp): number {
  const stable = new RegExp(regex.source, regex.flags);
  return Array.from(content.matchAll(stable)).length;
}

/**
 * Attempt to apply a single search-and-replace edit using multi-level fallback.
 * Matching strategy adapted from Kilo Code's EditFileTool:
 *   1. Exact literal match
 *   2. Strip line-number prefixes (LLM artifact)
 *   3. Whitespace-tolerant regex (flexible spacing)
 *   4. Token-based regex (ignore all whitespace)
 *   5. Fuzzy Levenshtein match (last resort)
 *
 * @param content - The current file content.
 * @param rawOldText - The original search text from the LLM.
 * @param newText - The replacement text.
 * @param _editIndex - The index of this edit (unused, kept for API compat).
 * @returns An EditResult indicating success or failure.
 */
function applyEdit(
  content: string,
  rawOldText: string,
  newText: string,
  _editIndex: number
): EditResult {
  const fail = (error: string): EditResult => ({
    success: false, content, method: "", error,
  });

  // Normalize line endings
  let oldText = normalizeLineEndings(rawOldText);
  const newTextNorm = normalizeLineEndings(newText);

  // === Level 1: Exact literal match ===
  const exactCount = countOccurrences(content, oldText);
  if (exactCount === 1) {
    return {
      success: true,
      content: safeLiteralReplace(content, oldText, newTextNorm),
      method: "exact",
      error: "",
    };
  }
  if (exactCount > 1) {
    return fail(
      `old_text matches ${String(exactCount)} locations. Provide more surrounding context to make it unique.`
    );
  }

  // === Level 2: Strip line-number prefixes ===
  const stripped = stripLineNumberPrefixes(oldText);
  if (stripped !== oldText) {
    const strippedCount = countOccurrences(content, stripped);
    if (strippedCount === 1) {
      return {
        success: true,
        content: safeLiteralReplace(content, stripped, newTextNorm),
        method: "stripped-line-numbers",
        error: "",
      };
    }
    oldText = stripped;
  }

  // === Level 3: Whitespace-tolerant regex (Kilo Code strategy 2) ===
  const wsRegex = buildWhitespaceTolerantRegex(oldText);
  const wsCount = countRegexMatches(content, wsRegex);
  if (wsCount === 1) {
    return {
      success: true,
      content: content.replace(wsRegex, () => newTextNorm),
      method: "whitespace-tolerant",
      error: "",
    };
  }

  // === Level 4: Token-based regex (Kilo Code strategy 3) ===
  const tokenRegex = buildTokenRegex(oldText);
  const tokenCount = countRegexMatches(content, tokenRegex);
  if (tokenCount === 1) {
    return {
      success: true,
      content: content.replace(tokenRegex, () => newTextNorm),
      method: "token-match",
      error: "",
    };
  }

  // === Level 5: Fuzzy matching with Levenshtein distance ===
  const fuzzyResult = fuzzySearch(content, oldText, 0.80);
  if (fuzzyResult !== null) {
    const adjustedNewText = indentAwareReplace(fuzzyResult.matchedText, newTextNorm);
    return {
      success: true,
      content: safeReplace(content, fuzzyResult.index, fuzzyResult.matchedText, adjustedNewText),
      method: `fuzzy (${String(Math.round(fuzzyResult.similarity * 100))}% match)`,
      error: "",
    };
  }

  // === All levels failed ===
  const nearby = findNearbyContext(content, rawOldText);
  return fail(
    "old_text not found using exact, whitespace-tolerant, token-based, or fuzzy matching. " +
    `Use read_file to see the current content, then retry with exact text.${nearby}`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Replace text at a specific index without regex substitution artifacts.
 *
 * @param content - The full content string.
 * @param index - The start index of the text to replace.
 * @param oldText - The old text to replace.
 * @param newText - The new text to insert.
 * @returns The content with the replacement applied.
 */
function safeReplace(
  content: string,
  index: number,
  oldText: string,
  newText: string
): string {
  // Escape $ in newText to prevent regex substitution artifacts
  void escapeDollarSigns; // imported but we use slice-based replace, not regex
  return content.slice(0, index) + newText + content.slice(index + oldText.length);
}

/** A single old_text → new_text edit pair. */
interface EditPair { old_text: string; new_text: string }

/**
 * Normalize the edits input from various formats different models may send.
 *
 * @param input - The raw tool input record.
 * @returns An array of EditPair objects, or null if the input is invalid.
 */
function normalizeEditsInput(input: Record<string, unknown>): EditPair[] | null {
  // 1. Standard: edits is an array
  if (Array.isArray(input.edits)) {
    return input.edits as EditPair[];
  }

  // 2. edits is a plain object {old_text, new_text} — wrap it
  if (
    input.edits !== null &&
    typeof input.edits === "object" &&
    typeof (input.edits as Record<string, unknown>).old_text === "string"
  ) {
    return [input.edits as EditPair];
  }

  // 3. edits is a JSON string — parse it (try double-decode for double-escaped strings)
  if (typeof input.edits === "string") {
    try {
      let parsed: unknown = JSON.parse(input.edits);
      // If still a string after first parse, try again (double-encoded)
      if (typeof parsed === "string") {
        parsed = JSON.parse(parsed);
      }
      return Array.isArray(parsed) ? parsed as EditPair[] : [parsed as EditPair];
    } catch {
      // ignore and fall through
    }
  }

  // 4. Singular "edit" key (some models use singular)
  if (
    input.edit !== null &&
    typeof input.edit === "object" &&
    typeof (input.edit as Record<string, unknown>).old_text === "string"
  ) {
    return [input.edit as EditPair];
  }

  // 5. Flat top-level old_text / new_text
  if (typeof input.old_text === "string" && typeof input.new_text === "string") {
    return [{ old_text: input.old_text, new_text: input.new_text } as EditPair];
  }

  return null;
}
