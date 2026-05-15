import * as path from 'path';
import * as vscode from 'vscode';

import { MAX_FILE_SIZE } from '../constants';

/**
 * Examples for resolveWorkspacePath:
 *
 * resolveWorkspacePath(Uri.file('/home/user/ws'), 'src/index.ts')
 *   → Uri.file('/home/user/ws/src/index.ts')
 *
 * resolveWorkspacePath(Uri.file('/home/user/ws'), '/home/user/ws/src/index.ts')
 *   → Uri.file('/home/user/ws/src/index.ts')  (absolute path within workspace — accepted)
 *
 * resolveWorkspacePath(Uri.file('/home/user/ws'), '../outside.ts')
 *   → throws Error('Path is outside the workspace root')
 */

/**
 * Resolves any path (absolute or relative) against a workspace root, ensuring it stays within
 * the workspace. Absolute paths that fall inside the workspace are accepted — useful when a user
 * copies a full path via "Copy Path" in the Explorer.
 *
 * @param workspaceRoot - The workspace root URI used as the sandboxed base directory.
 * @param inputPath - An absolute or workspace-relative path to resolve.
 * @returns A VSCode URI pointing to the resolved file within the workspace.
 * @throws If the path is empty, contains null bytes, or resolves outside the workspace root.
 */
export function resolveWorkspacePath(
  workspaceRoot: vscode.Uri,
  inputPath: unknown
): vscode.Uri {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw new Error("Path must not be empty");
  }

  if (inputPath.includes("\0")) {
    throw new Error("Path contains invalid characters");
  }

  let cleanedPath = inputPath.trim();

  // Handle URI-style paths (file:///path/to/file or file://path/to/file)
  if (cleanedPath.startsWith("file://")) {
    try {
      const uri = vscode.Uri.parse(cleanedPath);
      cleanedPath = uri.fsPath;
    } catch {
      // Fall through to normal processing
    }
  }

  // Handle leading/trailing quotes that models sometimes include
  cleanedPath = cleanedPath.replace(/^["']|["']$/g, "");

  // Handle backslash paths (Windows-style from some models)
  cleanedPath = cleanedPath.replace(/\\/g, "/");

  // Handle leading slash that might be workspace-relative
  // e.g., "/src/index.ts" should become "src/index.ts"
  if (cleanedPath.startsWith("/") && !cleanedPath.startsWith("//")) {
    // Check if this looks like an absolute path outside workspace
    // If it starts with common workspace root patterns, treat as relative
    const rootFsPath = workspaceRoot.fsPath;
    if (!cleanedPath.startsWith(rootFsPath)) {
      cleanedPath = cleanedPath.replace(/^\//, "");
    }
  }

  const rootFsPath = workspaceRoot.fsPath;

  // Accept absolute paths — security is enforced by the workspace-escape check below.
  // This handles the common case where a user copies a path via "Copy Path" in the Explorer.
  const resolvedFsPath = path.isAbsolute(cleanedPath)
    ? cleanedPath
    : path.resolve(rootFsPath, cleanedPath);

  const relative = path.relative(rootFsPath, resolvedFsPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Path is outside the workspace root (got: "${inputPath}"). ` +
      "Only paths within the workspace are allowed."
    );
  }

  return vscode.Uri.file(resolvedFsPath);
}

/**
 * Reads a file from the workspace with size validation.
 *
 * @param uri - The VSCode URI of the file to read.
 * @param startLine - Optional 1-indexed start line.
 * @param endLine - Optional 1-indexed end line (inclusive).
 * @returns The file content with line numbers.
 */
export async function readSandboxedFile(
  uri: vscode.Uri,
  startLine?: number,
  endLine?: number
): Promise<string> {
  const stat = await vscode.workspace.fs.stat(uri);

  if (stat.type === vscode.FileType.Directory) {
    const children = await vscode.workspace.fs.readDirectory(uri);
    const listing = children
      .slice(0, 100)
      .map(([name, type]) => type === vscode.FileType.Directory ? `${name}/` : name)
      .join("\n");
    return `Directory listing:\n${listing}`;
  }

  if (stat.size > MAX_FILE_SIZE && startLine === undefined) {
    throw new Error(
      `File is too large (${String(stat.size)} bytes). Use start_line/end_line to read a section, or use search_files.`
    );
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = new TextDecoder().decode(bytes);
  let lines = text.split("\n");

  // Apply line range
  const s = startLine !== undefined && startLine > 0 ? Math.max(1, startLine) : 1;
  const e = endLine !== undefined && endLine > 0 ? Math.min(lines.length, endLine) : lines.length;
  lines = lines.slice(s - 1, e);

  // Add line numbers
  const numbered = lines
    .map((line, i) => `${String(s + i).padStart(5)} | ${line}`)
    .join("\n");

  const header =
    startLine !== undefined || endLine !== undefined
      ? `${uri.fsPath} (lines ${String(s)}-${String(e)} of ${String(lines.length + (startLine ?? 1) - 1)})`
      : `${uri.fsPath} (${String(lines.length)} lines)`;

  return `${header}\n${numbered}`;
}
