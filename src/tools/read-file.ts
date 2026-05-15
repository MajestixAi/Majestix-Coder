import * as vscode from "vscode";

import { MAX_FILE_SIZE } from "../constants";
import { cachedReadFile } from "../util/file-cache";
import { resolveWorkspacePath } from "../util/path-safety";
import type {
  ToolContext,
  ToolHandler,
  ToolResult,
} from "./types";

export const readFileTool: ToolHandler = {
  definition: {
    name: "read_file",
    description:
      "Read the contents of a file from the workspace. Returns the file content with line numbers. " +
      "Use start_line and end_line to read a specific range for large files.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root",
        },
        start_line: {
          type: "number",
          description: "Start line (1-indexed). Omit to start from beginning.",
        },
        end_line: {
          type: "number",
          description: "End line (1-indexed, inclusive). Omit to read to end.",
        },
      },
      required: ["path"],
    },
  },

  requiresApproval: () => false,

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    // Normalize path from various parameter names models may use
    const filePath = (input.path ?? input.file_path ?? input.file ?? input.filepath ?? input.filename ?? input.filePath ?? input.fileName) as string | undefined;
    
    if (filePath === undefined || filePath.length === 0) {
      const receivedKeys = Object.keys(input).join(", ");
      return {
        tool_use_id: "",
        content: `Missing required parameter: path (file path relative to workspace root). Received keys: ${receivedKeys}. Expected: {"path": "relative/path/file.ts"}.`,
        is_error: true,
      };
    }
    
    const startLine = (input.start_line ?? input.startLine ?? input.line_start ?? input.from_line ?? input.offset) as number | undefined;
    const endLine = (input.end_line ?? input.endLine ?? input.line_end ?? input.to_line) as number | undefined;

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

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) {
        const children = await vscode.workspace.fs.readDirectory(uri);
        const listing = children
          .slice(0, 100)
          .map(([name, type]) => type === vscode.FileType.Directory ? `${name}/` : name)
          .join("\n");
        return { tool_use_id: "", content: `${filePath} is a directory. Contents:\n${listing}` };
      }
      if (stat.size > MAX_FILE_SIZE && startLine === undefined) {
        return {
          tool_use_id: "",
          content: `File is too large (${String(stat.size)} bytes, limit ${String(MAX_FILE_SIZE)}). Use start_line/end_line to read a section, or use search_files to find specific content.`,
          is_error: true,
        };
      }

      const text = await cachedReadFile(uri);
      let lines = text.split("\n");

      // Apply line range
      const start = startLine !== undefined && startLine > 0 ? Math.max(1, startLine) : 1;
      const end = endLine !== undefined && endLine > 0 ? Math.min(lines.length, endLine) : lines.length;
      lines = lines.slice(start - 1, end);

      // Add line numbers
      const numbered = lines
        .map((line, i) => `${String(start + i).padStart(5)} | ${line}`)
        .join("\n");

      const header =
        startLine !== undefined || endLine !== undefined
          ? `${filePath} (lines ${String(start)}-${String(end)} of ${String(text.split("\n").length)})`
          : `${filePath} (${String(lines.length)} lines)`;

      return { tool_use_id: "", content: `${header}\n${numbered}` };
    } catch {
      return {
        tool_use_id: "",
        content: `File not found: ${filePath}`,
        is_error: true,
      };
    }
  },
};
