import * as vscode from "vscode";

import { resolveWorkspacePath } from "../util/path-safety";
import { MAX_FILE_SIZE } from "../constants";
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
    const filePath = input.path as string;
    const startLine = input.start_line as number | undefined;
    const endLine = input.end_line as number | undefined;

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

      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(bytes);
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
