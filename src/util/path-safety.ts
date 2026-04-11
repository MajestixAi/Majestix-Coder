import * as path from "path";
import * as vscode from "vscode";

/*
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
 * copies a full path from the VSCode Explorer ("Copy Path") and pastes it into the chat.
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

  const rootFsPath = workspaceRoot.fsPath;

  // Accept absolute paths — security is enforced by the workspace-escape check below.
  // This handles the common case where a user copies a path via "Copy Path" in the Explorer.
  const resolvedFsPath = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(rootFsPath, inputPath);

  const relative = path.relative(rootFsPath, resolvedFsPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Path is outside the workspace root (got: "${inputPath}"). ` +
      "Only paths within the workspace are allowed."
    );
  }

  return vscode.Uri.file(resolvedFsPath);
}
