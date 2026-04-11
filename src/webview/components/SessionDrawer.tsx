import { useState, useCallback, useRef } from "preact/hooks";
import type { SessionSummary } from "../types";
import type { Action } from "../state";
import { postMessage, groupSessionsByDate } from "../utils";

interface Props {
  open: boolean;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  searchQuery: string;
  dispatch: (action: Action) => void;
}

export function SessionDrawer({ open, sessions, activeSessionId, searchQuery, dispatch }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const filtered = searchQuery
    ? sessions.filter(s => (s.title || "").toLowerCase().includes(searchQuery.toLowerCase()))
    : sessions;

  const groups = groupSessionsByDate(filtered);

  const handleLoad = useCallback((id: string) => {
    postMessage({ type: "session:load", id });
    dispatch({ type: "TOGGLE_DRAWER", open: false });
  }, [dispatch]);

  const handleDelete = useCallback((id: string) => {
    postMessage({ type: "session:delete", id });
  }, []);

  const startRename = useCallback((session: SessionSummary) => {
    setRenamingId(session.id);
    setRenameValue(session.title || "");
    setContextMenu(null);
    setTimeout(() => renameInputRef.current?.focus(), 50);
  }, []);

  const commitRename = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      postMessage({ type: "session:rename", id: renamingId, title: renameValue.trim() });
    }
    setRenamingId(null);
  }, [renamingId, renameValue]);

  const handleContextMenu = useCallback((e: MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
  }, []);

  // Close context menu on click
  const closeContextMenu = useCallback(() => { setContextMenu(null); }, []);

  return (
    <div class={`session-drawer ${open ? "open" : ""}`} onClick={closeContextMenu}>
      <div class="session-drawer-header">
        <h4>History</h4>
        <button
          title="Close"
          style="background:none;border:none;color:var(--vscode-foreground);cursor:pointer;font-size:16px;"
          onClick={() => { dispatch({ type: "TOGGLE_DRAWER", open: false }); }}
        >
          {"\u00d7"}
        </button>
      </div>

      <div style="padding:6px 12px 4px;">
        <input
          type="text"
          placeholder="Search sessions..."
          style="width:100%;background:var(--input-bg);color:var(--input-fg);border:1px solid var(--input-border);border-radius:3px;padding:4px 8px;font-size:11px;"
          aria-label="Search sessions"
          value={searchQuery}
          onInput={(e) => { dispatch({ type: "SET_SESSION_SEARCH", query: (e.target as HTMLInputElement).value }); }}
        />
      </div>

      <div class="session-list">
        {filtered.length === 0 ? (
          <div class="session-empty">No saved sessions</div>
        ) : (
          Array.from(groups.entries()).map(([label, groupSessions]) => (
            <div key={label}>
              <div class="session-date-group">{label}</div>
              {(groupSessions as SessionSummary[]).map(s => (
                <div
                  class={`session-item ${s.id === activeSessionId ? "active" : ""}`}
                  key={s.id}
                  onClick={() => { handleLoad(s.id); }}
                  onContextMenu={(e) => { handleContextMenu(e as unknown as MouseEvent, s.id); }}
                >
                  {renamingId === s.id ? (
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={renameValue}
                      style="width:100%;background:var(--input-bg);color:var(--input-fg);border:1px solid var(--vscode-focusBorder);border-radius:3px;padding:2px 4px;font-size:12px;"
                      onInput={(e) => { setRenameValue((e.target as HTMLInputElement).value); }}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                        if (e.key === "Escape") { setRenameValue(s.title || ""); (e.target as HTMLInputElement).blur(); }
                      }}
                      onClick={(e) => { e.stopPropagation(); }}
                    />
                  ) : (
                    <span
                      class="session-title"
                      title="Double-click to rename"
                      onDblClick={(e) => { e.stopPropagation(); startRename(s); }}
                    >
                      {s.title || "Untitled"}
                    </span>
                  )}
                  <span class="session-meta">{s.message_count} msgs</span>
                  <button
                    class="session-delete"
                    title="Delete session"
                    onClick={(e) => { e.stopPropagation(); handleDelete(s.id); }}
                  >
                    {"\u00d7"}
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      <div class="session-drawer-footer">
        <button onClick={() => {
          dispatch({ type: "TOGGLE_DRAWER", open: false });
          dispatch({ type: "RESET_CHAT" });
          postMessage({ type: "session:new" });
        }}>
          + New Chat
        </button>
        <button class="danger" onClick={() => { postMessage({ type: "session:deleteAll" }); }}>
          Clear All
        </button>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          class="session-context-menu"
          style={`left:${contextMenu.x}px;top:${contextMenu.y}px;`}
          onClick={(e) => { e.stopPropagation(); }}
        >
          <div
            class="session-context-menu-item"
            onClick={() => {
              const s = sessions.find(s => s.id === contextMenu.sessionId);
              if (s) startRename(s);
            }}
          >
            Rename
          </div>
          <div
            class="session-context-menu-item danger"
            onClick={() => { handleDelete(contextMenu.sessionId); setContextMenu(null); }}
          >
            Delete
          </div>
        </div>
      )}
    </div>
  );
}
