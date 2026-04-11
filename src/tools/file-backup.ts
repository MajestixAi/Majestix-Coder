import * as vscode from "vscode";

/**
 * In-memory file backup store.
 *
 * Before every write or edit, the original file content is stashed here.
 * If the operation needs to be reverted (e.g. the agent spirals and the user
 * wants to undo), `revert()` restores the last known good state.
 *
 * Backups are keyed by file URI string and limited to a configurable count
 * to prevent unbounded memory growth.
 */

/** A single backup entry with content and timestamp. */
interface BackupEntry {
  content: Uint8Array;
  timestamp: number;
}

const MAX_BACKUPS = 50;

const backups = new Map<string, BackupEntry>();

/**
 * Stash the current content of a file before overwriting it.
 * If the file doesn't exist yet, stores an empty backup (so revert = delete).
 *
 * @param uri - The VSCode URI of the file to back up.
 */
export async function stashBackup(uri: vscode.Uri): Promise<void> {
  try {
    const content = await vscode.workspace.fs.readFile(uri);
    setBackup(uri, content);
  } catch {
    // File doesn't exist yet — store empty sentinel
    setBackup(uri, new Uint8Array(0));
  }
}

/**
 * Revert a file to its backed-up content.
 *
 * @param uri - The VSCode URI of the file to revert.
 * @returns True if a backup existed and was restored.
 */
export async function revertFile(uri: vscode.Uri): Promise<boolean> {
  const key = uri.toString();
  const entry = backups.get(key);
  if (entry === undefined) { return false; }

  if (entry.content.length === 0) {
    // File didn't exist before — delete it
    try {
      await vscode.workspace.fs.delete(uri);
    } catch {
      // Already deleted or never created
    }
  } else {
    await vscode.workspace.fs.writeFile(uri, entry.content);
  }

  backups.delete(key);
  return true;
}

/**
 * Get the backed-up content for a file (without restoring it).
 *
 * @param uri - The VSCode URI of the file.
 * @returns The backed-up content, or undefined if no backup exists.
 */
export function getBackupContent(uri: vscode.Uri): Uint8Array | undefined {
  return backups.get(uri.toString())?.content;
}

/**
 * Check if a backup exists for a file.
 *
 * @param uri - The VSCode URI of the file.
 * @returns True if a backup exists.
 */
export function hasBackup(uri: vscode.Uri): boolean {
  return backups.has(uri.toString());
}

/**
 * Clear all backups (e.g. at the end of a successful agent run).
 */
export function clearAllBackups(): void {
  backups.clear();
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

/**
 * Store a backup entry, evicting the oldest if at capacity.
 *
 * @param uri - The VSCode URI of the file.
 * @param content - The file content to store.
 */
function setBackup(uri: vscode.Uri, content: Uint8Array): void {
  const key = uri.toString();

  // Evict oldest if at capacity
  if (!backups.has(key) && backups.size >= MAX_BACKUPS) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, v] of backups) {
      if (v.timestamp < oldestTime) {
        oldestTime = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) {
      backups.delete(oldestKey);
    }
  }

  backups.set(key, { content, timestamp: Date.now() });
}
