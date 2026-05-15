import * as vscode from "vscode";
import * as fs from "fs/promises";

/**
 * In-memory file read cache with TTL.
 *
 * Eliminates redundant vscode.workspace.fs.readFile() calls that occur
 * during write/edit operations (diff display, backup, line endings, approval).
 * Uses Node.js fs for local files (5-10× faster) and vscode.workspace.fs
 * for remote workspaces (SSH, containers, WSL).
 */

/** Cache entry with content and timestamp. */
interface CacheEntry {
  content: string;
  timestamp: number;
}

/** Time-to-live for cached entries (5 seconds). */
const CACHE_TTL_MS = 5_000;

const cache = new Map<string, CacheEntry>();

/**
 * Read a file with caching and fast local path.
 *
 * For local files (file:// scheme), uses Node.js fs.promises.readFile
 * which bypasses VSCode IPC overhead. For remote workspaces, falls back
 * to vscode.workspace.fs.
 *
 * Results are cached for CACHE_TTL_MS to avoid redundant reads.
 *
 * @param uri - The VSCode URI of the file to read.
 * @returns The file content as a string.
 */
export async function cachedReadFile(uri: vscode.Uri): Promise<string> {
  const key = uri.toString();
  const cached = cache.get(key);
  if (cached !== undefined && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.content;
  }

  let content: string;
  if (uri.scheme === "file") {
    // Fast path: Node.js fs for local files
    content = await fs.readFile(uri.fsPath, "utf-8");
  } else {
    // Remote workspace: use VSCode FS API
    const bytes = await vscode.workspace.fs.readFile(uri);
    content = new TextDecoder().decode(bytes);
  }

  cache.set(key, { content, timestamp: Date.now() });
  return content;
}

/**
 * Write a file with fast local path and cache invalidation.
 *
 * For local files, uses Node.js fs.promises.writeFile. For remote
 * workspaces, uses vscode.workspace.fs.
 *
 * Invalidates the cache entry for this file after writing.
 *
 * @param uri - The VSCode URI of the file to write.
 * @param content - The content to write.
 */
export async function cachedWriteFile(uri: vscode.Uri, content: string): Promise<void> {
  if (uri.scheme === "file") {
    // Fast path: Node.js fs for local files
    await fs.writeFile(uri.fsPath, content, "utf-8");
  } else {
    // Remote workspace: use VSCode FS API
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  }

  // Invalidate cache after write
  cache.delete(uri.toString());
}

/**
 * Invalidate the cache entry for a specific file.
 *
 * @param uri - The VSCode URI of the file to invalidate.
 */
export function invalidateCache(uri: vscode.Uri): void {
  cache.delete(uri.toString());
}

/**
 * Clear all cached entries.
 */
export function clearCache(): void {
  cache.clear();
}
