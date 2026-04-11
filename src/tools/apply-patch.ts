/**
 * apply_patch tool — unified diff format for reliable file editing.
 *
 * Uses the same patch format as GitHub Copilot (Apache 2.0, OpenAI reference).
 * Context lines locate where the edit goes via fuzzy matching.
 * The model only needs 1-3 context lines, not the entire old_text block.
 */

import * as vscode from "vscode";

import { stashBackup } from "./file-backup";
import { resolveWorkspacePath } from "../util/path-safety";
import type { ToolContext, ToolHandler, ToolResult } from "./types";

// ── Patch format constants ──────────────────────────────────────────

const PATCH_PREFIX = "*** Begin Patch";
const PATCH_SUFFIX = "*** End Patch";
const ADD_FILE_PREFIX = "*** Add File: ";
const DELETE_FILE_PREFIX = "*** Delete File: ";
const UPDATE_FILE_PREFIX = "*** Update File: ";
const END_OF_FILE_PREFIX = "*** End of File";
const CHUNK_DELIMITER = "@@";

// ── Types ───────────────────────────────────────────────────────────

interface PatchChunk {
  contextLines: string[];
  delLines: string[];
  insLines: string[];
}

interface FileOp {
  type: "add" | "delete" | "update";
  path: string;
  content?: string;      // for add
  chunks?: PatchChunk[]; // for update
}

// ── Parser ──────────────────────────────────────────────────────────

/**
 * Parse a patch string into file operations.
 *
 * @param patchText - The raw patch text.
 * @returns An array of file operations, or an error string.
 */
function parsePatch(patchText: string): FileOp[] | string {
  const trimmed = patchText.trim();

  // Find patch boundaries
  const startIdx = trimmed.indexOf(PATCH_PREFIX);
  const endIdx = trimmed.indexOf(PATCH_SUFFIX);
  if (startIdx === -1) {
    return `Invalid patch: missing "${PATCH_PREFIX}"`;
  }

  const body = endIdx === -1
    ? trimmed.slice(startIdx + PATCH_PREFIX.length)
    : trimmed.slice(startIdx + PATCH_PREFIX.length, endIdx);

  const lines = body.split("\n");
  const ops: FileOp[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trimEnd();

    if (line.length === 0 || line.startsWith(END_OF_FILE_PREFIX)) {
      i++;
      continue;
    }

    // ── Add file ──
    if (line.startsWith(ADD_FILE_PREFIX)) {
      const path = line.slice(ADD_FILE_PREFIX.length).trim();
      const contentLines: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (
          l.startsWith(UPDATE_FILE_PREFIX) ||
          l.startsWith(ADD_FILE_PREFIX) ||
          l.startsWith(DELETE_FILE_PREFIX) ||
          l.trimEnd() === PATCH_SUFFIX.trim() ||
          l.startsWith(END_OF_FILE_PREFIX)
        ) {
          break;
        }
        // Strip leading + if present (add file lines are prefixed with +)
        contentLines.push(l.startsWith("+") ? l.slice(1) : l);
        i++;
      }
      ops.push({ type: "add", path, content: contentLines.join("\n") });
      continue;
    }

    // ── Delete file ──
    if (line.startsWith(DELETE_FILE_PREFIX)) {
      const path = line.slice(DELETE_FILE_PREFIX.length).trim();
      ops.push({ type: "delete", path });
      i++;
      continue;
    }

    // ── Update file ──
    if (line.startsWith(UPDATE_FILE_PREFIX)) {
      const path = line.slice(UPDATE_FILE_PREFIX.length).trim();
      const chunks: PatchChunk[] = [];
      i++;

      while (i < lines.length) {
        const l = lines[i];
        if (
          l.startsWith(UPDATE_FILE_PREFIX) ||
          l.startsWith(ADD_FILE_PREFIX) ||
          l.startsWith(DELETE_FILE_PREFIX) ||
          l.trimEnd() === PATCH_SUFFIX.trim() ||
          l.startsWith(END_OF_FILE_PREFIX)
        ) {
          break;
        }

        // Skip @@ section headers
        if (l.startsWith(CHUNK_DELIMITER)) {
          i++;
          continue;
        }

        // Parse chunk: context lines (space prefix), del lines (- prefix), ins lines (+ prefix)
        const chunk: PatchChunk = { contextLines: [], delLines: [], insLines: [] };
        let hasContent = false;

        while (i < lines.length) {
          const cl = lines[i];
          if (
            cl.startsWith(UPDATE_FILE_PREFIX) ||
            cl.startsWith(ADD_FILE_PREFIX) ||
            cl.startsWith(DELETE_FILE_PREFIX) ||
            cl.trimEnd() === PATCH_SUFFIX.trim() ||
            cl.startsWith(END_OF_FILE_PREFIX) ||
            cl.startsWith(CHUNK_DELIMITER)
          ) {
            break;
          }

          if (cl.startsWith("-")) {
            chunk.delLines.push(cl.slice(1));
            hasContent = true;
          } else if (cl.startsWith("+")) {
            chunk.insLines.push(cl.slice(1));
            hasContent = true;
          } else {
            // Context line — space prefix or no prefix
            const ctx = cl.startsWith(" ") ? cl.slice(1) : cl;
            chunk.contextLines.push(ctx);
          }
          i++;
        }

        if (hasContent) {
          chunks.push(chunk);
        }
      }

      ops.push({ type: "update", path, chunks });
      continue;
    }

    // Unknown line — skip
    i++;
  }

  if (ops.length === 0) {
    return "No file operations found in patch";
  }

  return ops;
}

// ── Apply chunks to file content ────────────────────────────────────

/**
 * Find where a chunk's context lines match in the file, using fuzzy matching.
 *
 * @param fileLines - The lines of the file to search in.
 * @param contextLines - The context lines from the patch chunk.
 * @param delLines - The deletion lines from the patch chunk.
 * @param startFrom - The line index to start searching from.
 * @returns The line index where the context starts, or -1 if not found.
 */
function findContext(
  fileLines: string[],
  contextLines: string[],
  delLines: string[],
  startFrom: number
): number {
  if (contextLines.length === 0 && delLines.length === 0) {
    return startFrom;
  }

  // Build the pattern: context lines followed by del lines
  const pattern = [...contextLines, ...delLines];
  if (pattern.length === 0) {
    return startFrom;
  }

  const normalize = (s: string): string => s.trimEnd().replace(/\s+/g, " ");

  // Try exact match first
  for (let i = startFrom; i <= fileLines.length - pattern.length; i++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      if (fileLines[i + j] !== pattern[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      return i;
    }
  }

  // Fuzzy match — normalize whitespace
  for (let i = startFrom; i <= fileLines.length - pattern.length; i++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      if (normalize(fileLines[i + j]) !== normalize(pattern[j])) {
        match = false;
        break;
      }
    }
    if (match) {
      return i;
    }
  }

  // Fuzzy match — trimmed lines
  for (let i = startFrom; i <= fileLines.length - pattern.length; i++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      if (fileLines[i + j].trim() !== pattern[j].trim()) {
        match = false;
        break;
      }
    }
    if (match) {
      return i;
    }
  }

  // Last resort — match just the first context line anywhere
  if (contextLines.length > 0) {
    const first = normalize(contextLines[0]);
    for (let i = startFrom; i < fileLines.length; i++) {
      if (normalize(fileLines[i]) === first) {
        return i;
      }
    }
  }

  return -1;
}

/**
 * Apply update chunks to file content.
 *
 * @param content - The original file content.
 * @param chunks - The parsed patch chunks to apply.
 * @returns The modified content, count of applied chunks, and any failure messages.
 */
function applyChunks(content: string, chunks: PatchChunk[]): { result: string; applied: number; failed: string[] } {
  const fileLines = content.split("\n");
  let offset = 0; // cumulative line offset from previous edits
  let applied = 0;
  const failed: string[] = [];

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const searchFrom = Math.max(0, offset);

    const matchIdx = findContext(fileLines, chunk.contextLines, chunk.delLines, searchFrom);
    if (matchIdx === -1) {
      const preview = [...chunk.contextLines, ...chunk.delLines.map(l => "-" + l)].slice(0, 3).join("\\n");
      failed.push(`Chunk ${String(ci + 1)}: context not found — "${preview}"`);
      continue;
    }

    // Apply: remove context + del lines, insert context + ins lines
    const removeStart = matchIdx;
    const removeCount = chunk.contextLines.length + chunk.delLines.length;
    const insertLines = [...chunk.contextLines, ...chunk.insLines];

    fileLines.splice(removeStart, removeCount, ...insertLines);
    offset = removeStart + insertLines.length;
    applied++;
  }

  return { result: fileLines.join("\n"), applied, failed };
}

// ── Tool definition ─────────────────────────────────────────────────

export const applyPatchTool: ToolHandler = {
  definition: {
    name: "apply_patch",
    description:
      "Apply a patch to create, update, or delete files using unified diff format. " +
      "More reliable than edit_file for complex changes. Use this format:\n" +
      "*** Begin Patch\n" +
      "*** Update File: path/to/file.ts\n" +
      " context line (unchanged)\n" +
      "-line to remove\n" +
      "+line to add\n" +
      " context line (unchanged)\n" +
      "*** End Patch\n\n" +
      "For new files use '*** Add File: path'. For deletions use '*** Delete File: path'. " +
      "Context lines (space prefix) locate where the edit goes. You only need 1-3 context lines.",
    input_schema: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description: "The patch content in the format shown above",
        },
      },
      required: ["patch"],
    },
  },

  requiresApproval: () => true,

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const patchText = input.patch as string;
    if (typeof patchText !== "string" || patchText.trim().length === 0) {
      return { tool_use_id: "", content: "Missing required parameter: patch (string)", is_error: true };
    }

    const parsed = parsePatch(patchText);
    if (typeof parsed === "string") {
      return { tool_use_id: "", content: parsed, is_error: true };
    }

    const results: string[] = [];
    let totalApplied = 0;
    let totalFailed = 0;

    for (const op of parsed) {
      let uri: vscode.Uri;
      try {
        uri = resolveWorkspacePath(context.workspaceRoot, op.path);
      } catch (e: unknown) {
        results.push(`${op.path}: invalid path — ${e instanceof Error ? e.message : String(e)}`);
        totalFailed++;
        continue;
      }

      if (op.type === "add") {
        // Create new file
        try {
          await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(op.content ?? ""));
          const lineCount = (op.content ?? "").split("\n").length;
          results.push(`${op.path}: created (${String(lineCount)} lines)`);
          totalApplied++;
        } catch (e: unknown) {
          results.push(`${op.path}: create failed — ${e instanceof Error ? e.message : String(e)}`);
          totalFailed++;
        }
        continue;
      }

      if (op.type === "delete") {
        try {
          await stashBackup(uri);
          await vscode.workspace.fs.delete(uri);
          results.push(`${op.path}: deleted`);
          totalApplied++;
        } catch (e: unknown) {
          results.push(`${op.path}: delete failed — ${e instanceof Error ? e.message : String(e)}`);
          totalFailed++;
        }
        continue;
      }

      // Update file
      if (!op.chunks || op.chunks.length === 0) {
        results.push(`${op.path}: no changes in patch`);
        continue;
      }

      let rawContent: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        rawContent = new TextDecoder().decode(bytes);
      } catch {
        results.push(`${op.path}: file not found`);
        totalFailed++;
        continue;
      }

      await stashBackup(uri);

      const { result, applied, failed } = applyChunks(rawContent, op.chunks);

      if (applied > 0) {
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(result));
      }

      totalApplied += applied;
      totalFailed += failed.length;

      if (failed.length > 0) {
        results.push(`${op.path}: ${String(applied)}/${String(op.chunks.length)} chunks applied\n${failed.join("\n")}`);
      } else {
        results.push(`${op.path}: ${String(applied)} chunk(s) applied`);
      }
    }

    const summary = results.join("\n");
    const isError = totalApplied === 0 && totalFailed > 0;

    return {
      tool_use_id: "",
      content: `Patch: ${String(totalApplied)} applied, ${String(totalFailed)} failed\n${summary}`,
      is_error: isError,
    };
  },

};
