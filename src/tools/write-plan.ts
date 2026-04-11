import * as vscode from "vscode";

import { resolveWorkspacePath } from "../util/path-safety";
import type {
  ToolContext,
  ToolHandler,
  ToolResult,
} from "./types";

/**
 * Architect-mode tool: write a Markdown planning document.
 * Restricted to `.md` files only — use this to create or update plans, specs, and notes.
 * Cannot create or modify source code files.
 */
export const writePlanTool: ToolHandler = {
  definition: {
    name: "write_plan",
    description:
      "Create or update a Markdown (.md) planning document in the workspace. " +
      "Use this to write plans, architecture notes, specs, and task lists. " +
      "ONLY .md files are accepted — this tool cannot create or modify source code files. " +
      "Always provide the complete file content.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root. Must end with .md",
        },
        content: {
          type: "string",
          description: "The full Markdown content to write",
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
    const filePath = input.path as string;
    const newContent = input.content as string;

    if (!filePath.toLowerCase().endsWith(".md")) {
      return {
        tool_use_id: "",
        content: "write_plan only accepts .md files. To create or modify source code files, switch to Code mode.",
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

    let isNew = false;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      isNew = true;
    }

    const parentUri = vscode.Uri.joinPath(uri, "..");
    try {
      await vscode.workspace.fs.createDirectory(parentUri);
    } catch {
      // directory may already exist
    }

    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(newContent));

    const lineCount = newContent.split("\n").length;
    return {
      tool_use_id: "",
      content: isNew
        ? `Created planning document: ${filePath} (${String(lineCount)} lines)`
        : `Updated planning document: ${filePath} (${String(lineCount)} lines)`,
    };
  },
};
