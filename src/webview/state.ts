/**
 * Central webview state + reducer.
 * All UI state flows through a single dispatch so components stay pure.
 */

import type {
  ModelInfo,
  SessionSummary,
  AttachedFile,
  FileSearchResult,
  ConversationItem,
} from "./types";

// ── State ──

export interface AppState {
  // REDUCER HANDLES 34 ACTION TYPES - SEE STATE_AUDIT.md FOR DETAILS

  /** Ordered list of items in the conversation view. */
  items: ConversationItem[];

  /** Whether an agent run is in progress. */
  isStreaming: boolean;

  /** Accumulated text for the current assistant bubble. */
  currentContent: string;

  /** Currently active thinking block content. */
  thinkingContent: string;

  /** Whether the welcome screen should show. */
  hasMessages: boolean;

  /** Available models from the API. */
  models: ModelInfo[];

  /** Current mode (code/architect/ask/askonwrite). */
  mode: string;

  /** Currently selected model key ("" = auto). */
  selectedModel: string;

  /** Whether extended thinking is enabled. */
  thinkingEnabled: boolean;

  /** Files attached to the next message. */
  attachedFiles: AttachedFile[];

  /** Session list for the drawer. */
  sessions: SessionSummary[];

  /** Active session ID. */
  activeSessionId: string | null;

  /** Whether the session drawer is open. */
  drawerOpen: boolean;

  /** Session search query. */
  sessionSearch: string;

  /** API key status. */
  keyStatus: { hasKey: boolean; maskedKey: string };

  /** Agent status bar. */
  agentStatus: {
    active: boolean;
    step: number;
    cost: number;
    startTime: number;
  };

  /** Input history for up/down navigation. */
  inputHistory: string[];
  historyIndex: number;

  /** Last sent message for retry. */
  lastSentMessage: { text: string; model?: string; files: { path: string; name: string }[] } | null;

  /** Session-level auto-approve. */
  sessionAutoApprove: boolean;

  /** Timed auto-approve (epoch ms, 0 = inactive). */
  autoApproveUntil: number;

  /** At-mention file search results. */
  mentionResults: FileSearchResult[];

  /** Counter for unique IDs. */
  nextId: number;

  /** Slash command popup visible. */
  slashPopupVisible: boolean;

  /** Mention popup visible. */
  mentionPopupVisible: boolean;

  /** Whether a garble warning has been shown for the current turn. */
  garbleWarned: boolean;

  /** Whether an approval is currently pending user response. Blocks input when true. */
  hasPendingApproval: boolean;
}

export const initialState: AppState = {
  items: [],
  isStreaming: false,
  currentContent: "",
  thinkingContent: "",
  hasMessages: false,
  models: [],
  mode: "code",
  selectedModel: "",
  thinkingEnabled: true,
  attachedFiles: [],
  sessions: [],
  activeSessionId: null,
  drawerOpen: false,
  sessionSearch: "",
  keyStatus: { hasKey: false, maskedKey: "" },
  agentStatus: { active: false, step: 0, cost: 0, startTime: 0 },
  inputHistory: [],
  historyIndex: -1,
  lastSentMessage: null,
  sessionAutoApprove: false,
  autoApproveUntil: 0,
  mentionResults: [],
  nextId: 1,
  slashPopupVisible: false,
  mentionPopupVisible: false,
  garbleWarned: false,
  hasPendingApproval: false,
};

// ── Actions ──

export type Action =
  // Streaming lifecycle
  | { type: "STREAM_START"; text: string; model?: string; files: { path: string; name: string }[] }
  | { type: "STREAM_TEXT"; content: string }
  | { type: "STREAM_DONE" }
  | { type: "STREAM_STOPPED" }
  | { type: "STREAM_ERROR"; message: string }

  // Thinking
  | { type: "THINKING_START" }
  | { type: "THINKING_CONTENT"; content: string }
  | { type: "THINKING_DONE" }

  // Tool calls
  | { type: "TOOL_CALL"; id: string; name: string; input: Record<string, unknown> }
  | { type: "TOOL_RESULT"; id: string; content: string; isError: boolean }
  | { type: "COMMAND_OUTPUT"; content: string }

  // Approval
  | { type: "APPROVAL_REQUEST"; toolName: string; description: string; detail?: string }
  | { type: "APPROVAL_RESOLVE"; approved: boolean }

  // Completion & credits
  | { type: "COMPLETION"; result: string; command?: string }
  | { type: "CREDITS"; model: string; credits: number }

  // Models
  | { type: "SET_MODELS"; models: ModelInfo[] }

  // Mode / model
  | { type: "SET_MODE"; mode: string }
  | { type: "SET_MODEL"; model: string }
  | { type: "SET_THINKING_ENABLED"; enabled: boolean }

  // Files
  | { type: "FILES_ATTACHED"; files: AttachedFile[] }
  | { type: "REMOVE_FILE"; index: number }
  | { type: "CLEAR_FILES" }
  | { type: "CLEAR_PASTED_PATH"; path: string }

  // Sessions
  | { type: "SET_SESSIONS"; sessions: SessionSummary[] }
  | { type: "SET_ACTIVE_SESSION"; id: string | null }
  | { type: "SESSION_LOADED"; session: { id: string; mode: string; messages: { role: string; content: string | unknown[] }[] } }
  | { type: "SESSION_DELETED"; id: string }
  | { type: "TOGGLE_DRAWER"; open?: boolean }
  | { type: "SET_SESSION_SEARCH"; query: string }

  // Key status
  | { type: "SET_KEY_STATUS"; hasKey: boolean; maskedKey: string }

  // Chat reset
  | { type: "RESET_CHAT" }

  // Ask command (from extension)
  | { type: "ASK"; message: string; rawQuestion?: string }

  // Input history
  | { type: "PUSH_HISTORY"; text: string }
  | { type: "NAVIGATE_HISTORY"; direction: "up" | "down" }

  // Auto-approve
  | { type: "SET_SESSION_AUTO_APPROVE"; enabled: boolean }
  | { type: "START_AUTO_APPROVE_TIMER"; durationMs: number }

  // Mention
  | { type: "SET_MENTION_RESULTS"; files: FileSearchResult[] }
  | { type: "SET_MENTION_POPUP"; visible: boolean }
  | { type: "SET_SLASH_POPUP"; visible: boolean }

  // Toggle tool card / thinking collapsed
  | { type: "TOGGLE_ITEM_COLLAPSED"; itemId: string }

  // Focus
  | { type: "FOCUS_INPUT" }

  // File edit notification
  | { type: "FILE_EDITED"; path: string; op: "write" | "edit" | "patch" }

  // Garble warning
  | { type: "GARBLE_WARNING" };

// ── Helpers ──

function uid(state: AppState): [string, AppState] {
  const id = `item-${state.nextId}`;
  return [id, { ...state, nextId: state.nextId + 1 }];
}

function ensureTurnStart(state: AppState): AppState {
  const last = state.items[state.items.length - 1];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- last can be undefined when items is empty
  if (last?.kind === "turn-start") return state;
  const [id, s] = uid(state);
  return { ...s, items: [...s.items, { kind: "turn-start", id }] };
}

// ── Reducer ──

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "STREAM_START": {
      const [userId, s1] = uid(state);
      let displayText = action.text;
      if (state.attachedFiles.length > 0) {
        displayText += "\n\nAttached: " + state.attachedFiles.map(f => f.name).join(", ");
      }
      const items: ConversationItem[] = state.hasMessages
        ? [...state.items, { kind: "user", id: userId, text: displayText }]
        : [{ kind: "user", id: userId, text: displayText }];
      return {
        ...s1,
        items,
        isStreaming: true,
        currentContent: "",
        thinkingContent: "",
        hasMessages: true,
        attachedFiles: [],
        garbleWarned: false,
        lastSentMessage: { text: action.text, model: action.model, files: action.files },
        agentStatus: { active: true, step: 0, cost: 0, startTime: Date.now() },
      };
    }

    case "STREAM_TEXT": {
      // XML tool call patterns (<function=, </function>, <parameter=) are now parsed
      // by the agent loop's XML tool call parser. No garble detection needed.

      const newContent = state.currentContent + action.content;

      // If we're mid-stream (currentContent non-empty), just update the existing bubble.
      // Do NOT call ensureTurnStart here — it would insert a spurious turn-start
      // after the ai-text item on every chunk, fragmenting the turn grouping.
      if (state.currentContent.length > 0) {
        const lastAiText = findLastAiText(state.items);
        if (lastAiText) {
          const updated = state.items.map(item =>
            item.id === lastAiText.id && item.kind === "ai-text"
              ? { ...item, content: newContent }
              : item
          );
          return { ...state, items: updated, currentContent: newContent };
        }
      }

      // First chunk of a new bubble — ensure turn container exists
      const s = ensureTurnStart(state);
      const [id, s2] = uid(s);
      return {
        ...s2,
        currentContent: newContent,
        items: [...s2.items, { kind: "ai-text", id, content: newContent }],
      };
    }

    case "STREAM_DONE":
      return {
        ...state,
        isStreaming: false,
        currentContent: "",
        thinkingContent: "",
        garbleWarned: false,
        agentStatus: { ...state.agentStatus, active: false },
      };

    case "STREAM_STOPPED": {
      // If we have a current bubble with no content, mark as stopped
      const lastAi = findLastAiText(state.items);
      let items = state.items;
      if (lastAi && !state.currentContent.trim()) {
        items = items.map(item =>
          item.id === lastAi.id && item.kind === "ai-text"
            ? { ...item, content: "*Stopped*" }
            : item
        );
      }
      return {
        ...state,
        items,
        isStreaming: false,
        currentContent: "",
        agentStatus: { ...state.agentStatus, active: false },
      };
    }

    case "STREAM_ERROR": {
      let s = state;
      // Remove empty assistant bubble before error
      const lastAi = findLastAiText(s.items);
      if (lastAi && !s.currentContent.trim()) {
        s = { ...s, items: s.items.filter(i => i.id !== lastAi.id) };
      }
      const [id, s2] = uid(s);
      return {
        ...s2,
        isStreaming: false,
        currentContent: "",
        agentStatus: { ...s2.agentStatus, active: false },
        items: [...s2.items, { kind: "error", id, message: action.message }],
      };
    }

    case "THINKING_START": {
      const s = ensureTurnStart(state);
      return {
        ...s,
        agentStatus: {
          ...s.agentStatus,
          active: true,
          step: s.agentStatus.step + 1,
          startTime: s.agentStatus.startTime || Date.now(),
        },
      };
    }

    case "THINKING_CONTENT": {
      const newContent = state.thinkingContent + action.content;

      // If we're mid-stream into an existing thinking block, just update it
      if (state.thinkingContent.length > 0) {
        const lastThinking = findLastThinking(state.items);
        if (lastThinking) {
          const updated = state.items.map(item =>
            item.id === lastThinking.id && item.kind === "thinking"
              ? { ...item, thinking: { ...item.thinking, content: newContent } }
              : item
          );
          return { ...state, items: updated, thinkingContent: newContent };
        }
      }

      // First chunk — ensure turn container exists, then create thinking block
      const s = ensureTurnStart(state);
      const [id, s2] = uid(s);
      return {
        ...s2,
        thinkingContent: newContent,
        items: [...s2.items, {
          kind: "thinking", id, thinking: { id, content: newContent, streaming: true, collapsed: false },
        }],
      };
    }

    case "THINKING_DONE": {
      const lastThinking = findLastThinking(state.items);
      if (!lastThinking) return state;
      const updated = state.items.map(item =>
        item.id === lastThinking.id && item.kind === "thinking"
          ? { ...item, thinking: { ...item.thinking, streaming: false } }
          : item
      );
      return { ...state, items: updated, thinkingContent: "" };
    }

    case "TOOL_CALL": {
      const s = ensureTurnStart(state);
      const [id, s2] = uid(s);
      return {
        ...s2,
        currentContent: "",
        items: [...s2.items, {
          kind: "tool-call", id, tool: {
            id: action.id, name: action.name, input: action.input, collapsed: true,
          },
        }],
      };
    }

    case "TOOL_RESULT": {
      const updated = state.items.map(item => {
        if (item.kind === "tool-call" && item.tool.id === action.id) {
          return { ...item, tool: { ...item.tool, result: action.content, isError: action.isError, collapsed: !action.isError } };
        }
        return item;
      });
      return { ...state, items: updated };
    }

    case "COMMAND_OUTPUT": {
      // Append to the most recent execute_command tool card
      const items = [...state.items];
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item.kind === "tool-call" && item.tool.name === "execute_command") {
          const existing = item.tool.result === "Running..." ? "" : (item.tool.result ?? "");
          items[i] = {
            ...item,
            tool: { ...item.tool, result: existing + action.content, collapsed: false },
          };
          break;
        }
      }
      return { ...state, items };
    }

    case "APPROVAL_REQUEST": {
      // Auto-approve check
      if (state.sessionAutoApprove || Date.now() < state.autoApproveUntil) {
        // Will be handled by the component to auto-respond
        return state;
      }
      const s = ensureTurnStart(state);
      const [id, s2] = uid(s);
      return {
        ...s2,
        hasPendingApproval: true,
        items: [...s2.items, {
          kind: "approval", id, approval: {
            toolName: action.toolName, description: action.description, detail: action.detail,
          },
        }],
      };
    }

    case "APPROVAL_RESOLVE": {
      const updated = state.items.map(item => {
        if (item.kind === "approval" && !item.approval.resolved) {
          return { ...item, approval: { ...item.approval, resolved: true, approved: action.approved } };
        }
        return item;
      });
      return { ...state, items: updated, hasPendingApproval: false };
    }

    case "COMPLETION": {
      const [id, s] = uid(state);
      return {
        ...s,
        currentContent: "",
        items: [...s.items, { kind: "completion", id, result: action.result, command: action.command }],
      };
    }

    case "CREDITS": {
      const [id, s] = uid(state);
      return {
        ...s,
        agentStatus: { ...s.agentStatus, cost: s.agentStatus.cost + action.credits },
        items: [...s.items, { kind: "credits", id, model: action.model, credits: action.credits }],
      };
    }

    case "SET_MODELS":
      return { ...state, models: action.models };

    case "SET_MODE":
      return { ...state, mode: action.mode };

    case "SET_MODEL":
      return { ...state, selectedModel: action.model };

    case "SET_THINKING_ENABLED":
      return { ...state, thinkingEnabled: action.enabled };

    case "FILES_ATTACHED": {
      const existing = state.attachedFiles;
      const newFiles = action.files.filter(f => !existing.some(e => e.path === f.path));
      return { ...state, attachedFiles: [...existing, ...newFiles] };
    }

    case "REMOVE_FILE":
      return { ...state, attachedFiles: state.attachedFiles.filter((_, i) => i !== action.index) };

    case "CLEAR_FILES":
      return { ...state, attachedFiles: [] };

    case "CLEAR_PASTED_PATH":
      return state; // Handled in the input component

    case "SET_SESSIONS":
      return { ...state, sessions: action.sessions };

    case "SET_ACTIVE_SESSION":
      return { ...state, activeSessionId: action.id };

    case "SESSION_LOADED": {
      // Convert stored session messages to ConversationItems
      const items: ConversationItem[] = [];
      let s = { ...state, nextId: state.nextId };
      for (const msg of action.session.messages) {
        if (msg.role === "user") {
          if (typeof msg.content === "string") {
            const display = msg.content.split("\n<active_file")[0].split("\n<attached_file")[0].trim();
            const [id, ns] = uid(s);
            s = ns;
            items.push({ kind: "user", id, text: display });
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content as { type: string; tool_use_id?: string; content?: string; is_error?: boolean }[]) {
              if (block.type === "tool_result") {
                const [id, ns] = uid(s);
                s = ns;
                items.push({
                  kind: "tool-result", id,
                  toolId: block.tool_use_id ?? id,
                  content: block.content ?? "",
                  isError: block.is_error ?? false,
                });
              }
            }
          }
        } else if (msg.role === "assistant") {
          if (typeof msg.content === "string") {
            const [id, ns] = uid(s);
            s = ns;
            items.push({ kind: "ai-text", id, content: msg.content });
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content as { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]) {
              if (block.type === "text" && block.text?.trim()) {
                const [id, ns] = uid(s);
                s = ns;
                items.push({ kind: "ai-text", id, content: block.text });
              } else if (block.type === "tool_use") {
                const [id, ns] = uid(s);
                s = ns;
                items.push({
                  kind: "tool-call", id, tool: {
                    id: block.id ?? id,
                    name: block.name ?? "tool",
                    input: block.input ?? {},
                    collapsed: true,
                  },
                });
              }
            }
          }
        }
      }
      return {
        ...s,
        items,
        hasMessages: items.length > 0,
        activeSessionId: action.session.id,
        mode: action.session.mode || "code",
        drawerOpen: false,
      };
    }

    case "SESSION_DELETED": {
      if (state.activeSessionId === action.id) {
        return { ...state, activeSessionId: null, items: [], hasMessages: false };
      }
      return state;
    }

    case "TOGGLE_DRAWER":
      return { ...state, drawerOpen: action.open ?? !state.drawerOpen };

    case "SET_SESSION_SEARCH":
      return { ...state, sessionSearch: action.query };

    case "SET_KEY_STATUS":
      return { ...state, keyStatus: { hasKey: action.hasKey, maskedKey: action.maskedKey } };

    case "RESET_CHAT":
      return {
        ...state,
        items: [],
        hasMessages: false,
        currentContent: "",
        thinkingContent: "",
        activeSessionId: null,
        sessionAutoApprove: false,
        garbleWarned: false,
      };

    case "ASK": {
      const [userId, s1] = uid(state);
      const items: ConversationItem[] = state.hasMessages
        ? [...state.items, { kind: "user", id: userId, text: action.rawQuestion ?? action.message }]
        : [{ kind: "user", id: userId, text: action.rawQuestion ?? action.message }];
      return { ...s1, items, hasMessages: true, isStreaming: true, currentContent: "" };
    }

    case "PUSH_HISTORY": {
      const h = state.inputHistory;
      if (h[0] === action.text) return { ...state, historyIndex: -1 };
      const updated = [action.text, ...h].slice(0, 30);
      return { ...state, inputHistory: updated, historyIndex: -1 };
    }

    case "NAVIGATE_HISTORY": {
      if (state.inputHistory.length === 0) return state;
      let idx = state.historyIndex;
      if (action.direction === "up") {
        idx = Math.min(idx + 1, state.inputHistory.length - 1);
      } else {
        idx = idx - 1;
      }
      return { ...state, historyIndex: idx };
    }

    case "SET_SESSION_AUTO_APPROVE":
      return { ...state, sessionAutoApprove: action.enabled };

    case "START_AUTO_APPROVE_TIMER":
      return { ...state, autoApproveUntil: Date.now() + action.durationMs };

    case "SET_MENTION_RESULTS":
      return { ...state, mentionResults: action.files };

    case "SET_MENTION_POPUP":
      return { ...state, mentionPopupVisible: action.visible };

    case "SET_SLASH_POPUP":
      return { ...state, slashPopupVisible: action.visible };

    case "TOGGLE_ITEM_COLLAPSED": {
      const updated = state.items.map(item => {
        if (item.id === action.itemId) {
          if (item.kind === "tool-call") {
            return { ...item, tool: { ...item.tool, collapsed: !item.tool.collapsed } };
          }
          if (item.kind === "thinking") {
            return { ...item, thinking: { ...item.thinking, collapsed: !item.thinking.collapsed } };
          }
          if (item.kind === "approval") {
            return { ...item, approval: { ...item.approval, collapsed: !item.approval.collapsed } };
          }
        }
        return item;
      });
      return { ...state, items: updated };
    }

    case "FOCUS_INPUT":
      return state; // Handled imperatively

    case "FILE_EDITED": {
      const s = ensureTurnStart(state);
      const [id, s2] = uid(s);
      return { ...s2, items: [...s2.items, { kind: "file-edit", id, path: action.path, op: action.op }] };
    }

    case "GARBLE_WARNING": {
      if (state.garbleWarned) return state;
      const s = ensureTurnStart(state);
      const [id, s2] = uid(s);
      return { ...s2, garbleWarned: true, items: [...s2.items, { kind: "garble-warning", id }] };
    }

    default:
      return state;
  }
}

// ── Selectors ──

function findLastAiText(items: ConversationItem[]) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "ai-text") return items[i];
  }
  return null;
}

function findLastThinking(items: ConversationItem[]) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "thinking") return items[i];
  }
  return null;
}
