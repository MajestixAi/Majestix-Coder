/** Types shared across all webview components. */

/** A single chat message in the conversation. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

/** Model info from the API. */
export interface ModelInfo {
  key: string;
  display_name: string;
  provider: string;
  context_window: number;
  supports_tools?: boolean;
}

/** Session summary for the drawer list. */
export interface SessionSummary {
  id: string;
  title: string;
  mode: string;
  model: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

/** Full session (when loaded). */
export interface StoredSession {
  id: string;
  title: string;
  mode: string;
  model: string;
  messages: {
    role: string;
    content: string | ContentBlock[];
  }[];
}

/** Content block inside a message. */
export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

/** Attached file chip. */
export interface AttachedFile {
  path: string;
  name: string;
  content?: string;
}

/** File search result. */
export interface FileSearchResult {
  path: string;
  name: string;
}

/** Tool card state. */
export interface ToolCardState {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  collapsed: boolean;
}

/** Approval request state. */
export interface ApprovalState {
  toolName: string;
  description: string;
  detail?: string;
  resolved?: boolean;
  approved?: boolean;
  collapsed?: boolean;
}

/** Thinking block state. */
export interface ThinkingState {
  id: string;
  content: string;
  streaming: boolean;
  collapsed: boolean;
}

/** Rendered message element in the conversation view. */
export type ConversationItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "ai-text"; id: string; content: string }
  | { kind: "tool-call"; id: string; tool: ToolCardState }
  | { kind: "tool-result"; id: string; toolId: string; content: string; isError: boolean }
  | { kind: "approval"; id: string; approval: ApprovalState }
  | { kind: "thinking"; id: string; thinking: ThinkingState }
  | { kind: "completion"; id: string; result: string; command?: string }
  | { kind: "error"; id: string; message: string }
  | { kind: "credits"; id: string; model: string; credits: number }
  | { kind: "file-edit"; id: string; path: string; op: "write" | "edit" | "patch" }
  | { kind: "turn-start"; id: string }
  | { kind: "garble-warning"; id: string };

// ── Messages between webview ↔ extension host ──

/** Messages the webview posts TO the extension. */
export type WebviewOutMessage =
  | { type: "sendAgent"; message: string; model?: string; mode: string; attachedFiles?: { path: string; name: string }[] }
  | { type: "stop" }
  | { type: "loadModels" }
  | { type: "newChat" | "session:new" }
  | { type: "setMode"; mode: string }
  | { type: "setThinking"; enabled: boolean }
  | { type: "approvalResponse"; approved: boolean }
  | { type: "pickFiles" }
  | { type: "dropFiles"; names: string[] }
  | { type: "dropUris"; uris: string[] }
  | { type: "session:list" }
  | { type: "session:load"; id: string }
  | { type: "session:delete"; id: string }
  | { type: "session:deleteAll" }
  | { type: "session:rename"; id: string; title: string }
  | { type: "downloadChat"; content: string }
  | { type: "searchFiles"; query: string }
  | { type: "pickFileByPath"; path: string }
  | { type: "copyToClipboard"; content: string }
  | { type: "pastePath"; path: string }
  | { type: "openSettings" }
  | { type: "keyStatus" }
  | { type: "keySet" }
  | { type: "keyClear" };

/** Messages the extension posts TO the webview. */
export type ExtensionInMessage =
  | { type: "thinking" }
  | { type: "thinking_content"; content: string }
  | { type: "thinking_done" }
  | { type: "text"; content: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; content: string; is_error: boolean }
  | { type: "file_edited"; path: string; op: "write" | "edit" | "patch" }
  | { type: "command_output"; content: string }
  | { type: "approval_request"; toolName: string; description: string; detail?: string }
  | { type: "approval_detail_update"; toolName: string; detail: string }
  | { type: "completion"; result: string; command?: string }
  | { type: "credits"; model: string; credits_used: number }
  | { type: "done"; conversation: unknown[] }
  | { type: "stopped" }
  | { type: "error"; message: string }
  | { type: "models"; models: ModelInfo[] }
  | { type: "ask"; message: string; rawQuestion?: string }
  | { type: "filesAttached"; files: AttachedFile[] }
  | { type: "clearPastedPath"; path: string }
  | { type: "session:list"; sessions: SessionSummary[] }
  | { type: "session:loaded"; session: StoredSession }
  | { type: "session:active"; id: string | null }
  | { type: "session:deleted"; id: string }
  | { type: "session:error"; message: string }
  | { type: "focusInput" }
  | { type: "keyStatus"; hasKey: boolean; maskedKey?: string }
  | { type: "fileSearchResults"; files: FileSearchResult[] };
