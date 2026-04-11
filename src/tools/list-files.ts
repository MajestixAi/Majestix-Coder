import * as path from "path";
import * as vscode from "vscode";
import type { ToolHandler, ToolResult, ToolContext } from "./types";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".venv", "venv", ".tox", "coverage", ".nyc_output", ".majestix",
]);

const MAX_ENTRIES = 500;

export const listFilesTool: ToolHandler = {
  definition: {
    name: "list_files",
    description:
      "List files and directories at a given path. Useful for understanding project structure. " +
      "Results respect .gitignore-style ignores (node_modules, .git, etc).",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory path relative to workspace root. Defaults to root if omitted.",
        },
        recursive: {
          type: "boolean",
          description: "If true, list files recursively. Default: false.",
        },
      },
    },
  },

  requiresApproval: () => false,

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const rawPath = input.path as string | undefined;
    if (typeof rawPath === "string" && path.isAbsolute(rawPath)) {
      return {
        tool_use_id: "",
        content: `Absolute paths are not allowed (got: "${rawPath}"). Use a path relative to the workspace root (e.g. "src" not "/Users/.../src").`,
        is_error: true,
      };
    }
    const relPath = rawPath ?? ".";
    const recursive = (input.recursive as boolean | undefined) ?? false;
    const baseUri = vscode.Uri.joinPath(context.workspaceRoot, relPath);

    const entries: string[] = [];

    try {
      await walk(baseUri, "", entries, recursive);
    } catch {
      return {
        tool_use_id: "",
        content: `Directory not found: ${relPath}`,
        is_error: true,
      };
    }

    if (entries.length === 0) {
      return { tool_use_id: "", content: `Directory is empty: ${relPath}` };
    }

    const truncated = entries.length >= MAX_ENTRIES ? `\n(truncated at ${String(MAX_ENTRIES)} entries)` : "";
    return {
      tool_use_id: "",
      content: entries.join("\n") + truncated,
    };
  },
};

/**
 * Recursively walks a directory and collects file and folder paths.
 *
 * @param base - The base URI of the directory to walk.
 * @param prefix - The relative path prefix to prepend to each entry name.
 * @param result - The accumulator array to push found paths into.
 * @param recursive - Whether to descend into subdirectories.
 */
async function walk(
  base: vscode.Uri,
  prefix: string,
  result: string[],
  recursive: boolean
): Promise<void> {
  if (result.length >= MAX_ENTRIES) {return;}

  let children: [string, vscode.FileType][];
  try {
    children = await vscode.workspace.fs.readDirectory(base);
  } catch {
    return;
  }

  children.sort((a, b) => a[0].localeCompare(b[0]));

  for (const [name, type] of children) {
    if (result.length >= MAX_ENTRIES) {break;}

    const entryPath = prefix.length > 0 ? `${prefix}/${name}` : name;

    if (type === vscode.FileType.Directory) {
      if (IGNORED_DIRS.has(name) || name.startsWith(".")) {continue;}
      result.push(`${entryPath}/`);
      if (recursive) {
        await walk(vscode.Uri.joinPath(base, name), entryPath, result, true);
      }
    } else {
      result.push(entryPath);
    }
  }
}
