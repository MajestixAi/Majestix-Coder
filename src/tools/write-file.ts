import * as vscode from 'vscode';

import { MAX_WRITE_SIZE } from '../constants';
import {
  cachedReadFile,
  cachedWriteFile,
} from '../util/file-cache';
import { resolveWorkspacePath } from '../util/path-safety';
import {
  detectLineEnding,
  restoreLineEndings,
} from './diff-match';
import { stashBackup } from './file-backup';
import { collectPostWriteDiagnostics } from './post-write-diagnostics';
import type {
  ToolContext,
  ToolHandler,
  ToolResult,
} from './types';

export const writeToFileTool: ToolHandler = {
  definition: {
    name: "write_to_file",
    description:
      "Create a new file or overwrite an existing file with the provided content. " +
      "The user will see a diff and must approve before the file is written. " +
      "Always provide the COMPLETE file content — do not use placeholders or truncation.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root",
        },
        content: {
          type: "string",
          description: "The full file content to write",
        },
      },
      required: ["path", "content"],
    },
  },

  requiresApproval: () => true,

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    // Normalize path from various parameter names models may use
    const filePath = (input.path ?? input.file_path ?? input.file ?? input.filepath ?? input.filename ?? input.filePath ?? input.fileName) as string | undefined;
    // Normalize content from various parameter names models may use
    const newContent = (input.content ?? input.file_text ?? input.text ?? input.data ?? input.source ?? input.code ?? input.fileContent ?? input.file_content) as string | undefined;
    
    if (filePath === undefined || filePath.length === 0) {
      const receivedKeys = Object.keys(input).join(", ");
      return {
        tool_use_id: "",
        content: `Missing required parameter: path (file path relative to workspace root). Received keys: ${receivedKeys}. Expected: {"path": "relative/path/file.ts", "content": "full file content"}.`,
        is_error: true,
      };
    }
    
    if (newContent === undefined) {
      const receivedKeys = Object.keys(input).join(", ");
      return {
        tool_use_id: "",
        content: `Missing required parameter: content (full file content to write). Received keys: ${receivedKeys}. Expected: {"path": "relative/path/file.ts", "content": "full file content"}.`,
        is_error: true,
      };
    }
    
    let uri: vscode.Uri;
    try {
      uri = resolveWorkspacePath(context.workspaceRoot, filePath);
    } catch (e: unknown) {
      return {
        tool_use_id: "",
        content: `Invalid path: ${e instanceof Error ? e.message : String(e)}\n\nPath received: "${filePath}"\n\nMake sure the path is relative to the workspace root and uses forward slashes (/).`,
        is_error: true,
      };
    }

    // Read existing content (if any) for diff display and line ending detection
    let oldContent = "";
    let isNew = false;
    let originalLineEnding: "\n" | "\r\n" = "\n";
    try {
      oldContent = await cachedReadFile(uri);
      originalLineEnding = detectLineEnding(oldContent);
    } catch {
      isNew = true;
    }

    // Safety: reject content that exceeds MAX_WRITE_SIZE to prevent runaway writes
    if (newContent.length > MAX_WRITE_SIZE) {
      return {
        tool_use_id: "",
        content: `Content too large (${String(newContent.length)} bytes, limit ${String(MAX_WRITE_SIZE)}). Please split into smaller files or use edit_file for targeted changes.`,
        is_error: true,
      };
    }

    // Stash backup before modifying (for rollback capability)
    await stashBackup(uri);

    // Ensure parent directory exists
    const parentUri = vscode.Uri.joinPath(uri, "..");
    try {
      await vscode.workspace.fs.createDirectory(parentUri);
    } catch {
      // directory may already exist
    }

    // Preserve original line endings if updating an existing file
    const finalContent = isNew ? newContent : restoreLineEndings(newContent, originalLineEnding);

    // Write the file
    await cachedWriteFile(uri, finalContent);

    // Wait briefly for VSCode diagnostics to catch up, then collect any new errors
    const diagnosticFeedback = await collectPostWriteDiagnostics(uri);

    // Build result summary
    if (isNew) {
      const lineCount = newContent.split("\n").length;
      return {
        tool_use_id: "",
        content: `Created new file: ${filePath} (${String(lineCount)} lines)${diagnosticFeedback}`,
      };
    }

    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const added = newLines.length - oldLines.length;
    const desc = added >= 0 ? `+${String(added)} lines` : `${String(added)} lines`;

    return {
      tool_use_id: "",
      content: `Updated ${filePath} (${String(oldLines.length)} → ${String(newLines.length)} lines, ${desc})${diagnosticFeedback}`,
    };
  },
};


