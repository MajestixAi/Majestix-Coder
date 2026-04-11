/**
 * File-based session storage for conversation persistence.
 *
 * Layout on disk:
 *   {workspace}/.majestix/sessions/_index.json    — SessionSummary[]
 *   {workspace}/.majestix/sessions/{uuid}.json    — StoredSession
 *
 * Uses vscode.workspace.fs so it works with remote workspaces too.
 */

import * as vscode from "vscode";
import * as crypto from "crypto";

import type { Message } from "../api/client";
import type { SessionSummary, StoredSession } from "./types";

const SESSIONS_DIR = ".majestix/sessions";
const INDEX_FILE = "_index.json";
const MAX_SESSIONS = 50;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * File-backed store for managing conversation sessions on disk.
 * Provides CRUD operations and an index of session summaries.
 */
export class SessionStore {
  private readonly _workspaceRoot: vscode.Uri;
  private readonly _sessionsDir: vscode.Uri;
  private readonly _indexUri: vscode.Uri;

  /**
   * Creates a SessionStore rooted at the given workspace URI.
   *
   * @param workspaceRoot - The workspace root URI where session data will be stored.
   */
  constructor(workspaceRoot: vscode.Uri) {
    this._workspaceRoot = workspaceRoot;
    this._sessionsDir = vscode.Uri.joinPath(workspaceRoot, SESSIONS_DIR);
    this._indexUri = vscode.Uri.joinPath(this._sessionsDir, INDEX_FILE);
  }

  // ── Directory ─────────────────────────────────────────────

  /**
   * Ensures the sessions directory exists and the workspace .gitignore covers it.
   */
  async ensureDir(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this._sessionsDir);
    } catch {
      // already exists
    }
    await this._ensureGitignore();
  }

  // ── CRUD ──────────────────────────────────────────────────

  /**
   * List all sessions (lightweight summaries), most-recent first.
   *
   * @returns An array of session summaries sorted by most recent first.
   */
  async list(): Promise<SessionSummary[]> {
    return this._readIndex();
  }

  /**
   * Load a full session by ID (includes messages).
   *
   * @param id - The unique ID of the session to retrieve.
   * @returns The full stored session, or null if not found.
   */
  async get(id: string): Promise<StoredSession | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this._sessionUri(id));
      return JSON.parse(decoder.decode(bytes)) as StoredSession;
    } catch {
      return null;
    }
  }

  /**
   * Create a new session. Writes file + updates index.
   *
   * @param params - The initial session parameters.
   * @param params.title - The display title for the session.
   * @param params.mode - The agent mode (e.g. "code", "ask", "architect").
   * @param params.model - The model key used for this session.
   * @param params.messages - The initial messages array.
   * @returns The newly created stored session object.
   */
  async create(params: {
    title: string;
    mode: string;
    model: string;
    messages: Message[];
  }): Promise<StoredSession> {
    await this.ensureDir();

    const now = new Date().toISOString();
    const session: StoredSession = {
      id: crypto.randomUUID(),
      title: params.title,
      mode: params.mode,
      model: params.model,
      created_at: now,
      updated_at: now,
      messages: params.messages,
    };

    await this._writeSession(session);

    // Update index — prepend new session
    const index = await this._readIndex();
    index.unshift(toSummary(session));

    // Enforce limit — prune oldest
    if (index.length > MAX_SESSIONS) {
      const pruned = index.splice(MAX_SESSIONS);
      for (const old of pruned) {
        try { await vscode.workspace.fs.delete(this._sessionUri(old.id)); } catch { /* best-effort cleanup */ }
      }
    }

    await this._writeIndex(index);
    return session;
  }

  /**
   * Update an existing session (messages + metadata).
   *
   * @param session - The session object with updated data to persist.
   */
  async update(session: StoredSession): Promise<void> {
    session.updated_at = new Date().toISOString();
    await this._writeSession(session);

    // Move to front of index
    const index = await this._readIndex();
    const filtered = index.filter(s => s.id !== session.id);
    filtered.unshift(toSummary(session));
    await this._writeIndex(filtered);
  }

  /**
   * Delete a session by ID.
   *
   * @param id - The unique ID of the session to delete.
   */
  async delete(id: string): Promise<void> {
    try { await vscode.workspace.fs.delete(this._sessionUri(id)); } catch { /* best-effort */ }
    const index = await this._readIndex();
    await this._writeIndex(index.filter(s => s.id !== id));
  }

  /** Delete all sessions. */
  async deleteAll(): Promise<void> {
    const index = await this._readIndex();
    for (const s of index) {
      try { await vscode.workspace.fs.delete(this._sessionUri(s.id)); } catch { /* best-effort */ }
    }
    await this._writeIndex([]);
  }

  // ── Helpers ───────────────────────────────────────────────

  /**
   * If a .gitignore exists in the workspace root, ensure `.majestix/` is listed.
   * Runs once per session store lifetime (fire-and-forget, never blocks).
   */
  private async _ensureGitignore(): Promise<void> {
    const gitignoreUri = vscode.Uri.joinPath(this._workspaceRoot, ".gitignore");
    try {
      const bytes = await vscode.workspace.fs.readFile(gitignoreUri);
      const content = decoder.decode(bytes);
      if (content.includes(".majestix")) {return;} // already covered
      const newline = content.endsWith("\n") ? "" : "\n";
      const updated = content + newline + ".majestix/\n";
      await vscode.workspace.fs.writeFile(gitignoreUri, encoder.encode(updated));
    } catch {
      // no .gitignore found — nothing to do
    }
  }

  /**
   * Builds the URI for a session file given its ID.
   *
   * @param id - The session ID to compute a URI for.
   * @returns A VSCode URI pointing to the session JSON file.
   */
  private _sessionUri(id: string): vscode.Uri {
    const safeId = id.replace(/[^a-zA-Z0-9-]/g, "");
    return vscode.Uri.joinPath(this._sessionsDir, `${safeId}.json`);
  }

  // ── Index ─────────────────────────────────────────────────

  /**
   * Reads and parses the sessions index file.
   *
   * @returns An array of session summaries, or an empty array if the index doesn't exist.
   */
  private async _readIndex(): Promise<SessionSummary[]> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this._indexUri);
      return JSON.parse(decoder.decode(bytes)) as SessionSummary[];
    } catch {
      return [];
    }
  }

  /**
   * Serializes and writes the sessions index to disk.
   *
   * @param summaries - The array of session summaries to persist as the index.
   */
  private async _writeIndex(summaries: SessionSummary[]): Promise<void> {
    await vscode.workspace.fs.writeFile(
      this._indexUri,
      encoder.encode(JSON.stringify(summaries, null, 2))
    );
  }

  /**
   * Writes a full session object to its individual JSON file.
   *
   * @param session - The session to serialize and write to disk.
   */
  private async _writeSession(session: StoredSession): Promise<void> {
    await vscode.workspace.fs.writeFile(
      this._sessionUri(session.id),
      encoder.encode(JSON.stringify(session, null, 2))
    );
  }
}

// ── Pure helpers ──────────────────────────────────────────────

/**
 * Creates a lightweight session summary from a full session object.
 *
 * @param session - The full session to derive a summary from.
 * @returns A session summary containing only metadata fields.
 */
function toSummary(session: StoredSession): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    mode: session.mode,
    model: session.model,
    created_at: session.created_at,
    updated_at: session.updated_at,
    message_count: session.messages.length,
  };
}

/**
 * Generate a session title from the first user message.
 * Strips enriched context (<active_file>, <attached_file>) the extension appends,
 * then returns the first 7 words so the title is always a clean phrase rather than
 * a mid-word truncation.
 *
 * @param firstUserMessage - The raw first user message string to derive a title from.
 * @returns A trimmed word-bounded title string suitable for display.
 */
export function generateSessionTitle(firstUserMessage: string): string {
  const cleaned = firstUserMessage
    .split("\n<active_file")[0]
    .split("\n<attached_file")[0]
    .replace(/\n/g, " ")
    .trim();

  const words = cleaned.split(/\s+/);
  if (words.length <= 7) {return cleaned;}
  return words.slice(0, 7).join(" ") + "\u2026";
}
