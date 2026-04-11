/**
 * Session persistence types for the Majestix AI VSCode extension.
 *
 * Sessions are stored as JSON files on disk at {workspace}/.majestix/sessions/.
 * An index file (_index.json) provides lightweight summaries for the sidebar list.
 */

import type { Message } from "../api/client";

// ── Stored data ─────────────────────────────────────────────

/** Full session persisted to {id}.json — includes the complete conversation. */
export interface StoredSession {
  /** UUID v4 */
  id: string;
  /** Auto-generated from first user message, max 60 chars */
  title: string;
  /** Agent mode at session creation: "code" | "architect" | "ask" */
  mode: string;
  /** Last model key used (empty string = auto) */
  model: string;
  /** ISO 8601 */
  created_at: string;
  /** ISO 8601 — updated on every save */
  updated_at: string;
  /** Full conversation array including text, tool_use, and tool_result blocks */
  messages: Message[];
  /** Rolling compact summary from the last compaction, carried forward across turns. */
  compact_summary?: string;
}

/** Lightweight summary for sidebar list — derived from StoredSession, no messages. */
export interface SessionSummary {
  id: string;
  title: string;
  mode: string;
  model: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

// ── Webview ↔ Extension message protocol ────────────────────

/** Messages the webview sends to the extension for session management. */
export type SessionCommand =
  | { type: "session:list" }
  | { type: "session:load"; id: string }
  | { type: "session:delete"; id: string }
  | { type: "session:deleteAll" }
  | { type: "session:new" };

/** Messages the extension sends to the webview for session management. */
export type SessionEvent =
  | { type: "session:list"; sessions: SessionSummary[] }
  | { type: "session:loaded"; session: StoredSession }
  | { type: "session:active"; id: string | null }
  | { type: "session:deleted"; id: string }
  | { type: "session:error"; message: string };
