import { useRef, useCallback, useEffect, useState } from "preact/hooks";
import type { AttachedFile, FileSearchResult } from "../types";
import type { Action } from "../state";
import { postMessage } from "../utils";

const SLASH_COMMANDS = [
  { cmd: "/new", desc: "Start a new chat" },
  { cmd: "/clear", desc: "Clear current chat" },
  { cmd: "/mode code", desc: "Switch to Code mode" },
  { cmd: "/mode architect", desc: "Switch to Architect mode" },
  { cmd: "/mode ask", desc: "Switch to Ask mode" },
  { cmd: "/history", desc: "Open session history" },
];

interface Props {
  isStreaming: boolean;
  attachedFiles: AttachedFile[];
  mode: string;
  selectedModel: string;
  inputHistory: string[];
  historyIndex: number;
  mentionResults: FileSearchResult[];
  dispatch: (action: Action) => void;
}

export function InputArea({
  isStreaming, attachedFiles, mode, selectedModel,
  inputHistory, historyIndex, mentionResults, dispatch,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [inputValue, setInputValue] = useState("");
  const [slashMatches, setSlashMatches] = useState<typeof SLASH_COMMANDS>([]);
  const [showSlash, setShowSlash] = useState(false);
  const [showMention, setShowMention] = useState(false);
  const mentionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore from history navigation
  useEffect(() => {
    if (historyIndex >= 0 && historyIndex < inputHistory.length) {
      setInputValue(inputHistory[historyIndex]);
    } else if (historyIndex < 0) {
      // Don't reset if user is typing
    }
  }, [historyIndex, inputHistory]);

  // Focus on focusInput
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data as { type?: string; path?: string };
      if (data.type === "focusInput") inputRef.current?.focus();
    };
    window.addEventListener("message", handler);
    return () => { window.removeEventListener("message", handler); };
  }, []);

  // Clear pasted path
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data as { type?: string; path?: string };
      if (data.type === "clearPastedPath" && data.path && inputValue.includes(data.path)) {
        const pathToReplace = data.path;
        setInputValue(v => v.replace(pathToReplace, "").trim());
      }
    };
    window.addEventListener("message", handler);
    return () => { window.removeEventListener("message", handler); };
  }, [inputValue]);

  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = String(Math.min(el.scrollHeight, 200)) + "px";
  }, []);

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text || isStreaming) return;

    // Slash commands
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    if (cmd === "/new" || cmd === "/clear") {
      dispatch({ type: "RESET_CHAT" });
      postMessage({ type: "session:new" });
      setInputValue("");
      setShowSlash(false);
      return;
    }
    if (cmd === "/mode") {
      const m = (parts[1] ?? "").trim();
      if (["code", "architect", "ask", "askonwrite"].includes(m)) {
        dispatch({ type: "SET_MODE", mode: m });
        postMessage({ type: "setMode", mode: m });
        setInputValue("");
        setShowSlash(false);
        return;
      }
    }
    if (cmd === "/history") {
      dispatch({ type: "TOGGLE_DRAWER", open: true });
      postMessage({ type: "session:list" });
      setInputValue("");
      setShowSlash(false);
      return;
    }

    // Normal send
    const files = attachedFiles.map(f => ({ path: f.path, name: f.name }));
    dispatch({ type: "STREAM_START", text, model: selectedModel || undefined, files });
    dispatch({ type: "PUSH_HISTORY", text });
    postMessage({
      type: "sendAgent",
      message: text,
      model: selectedModel || undefined,
      mode,
      attachedFiles: files,
    });
    setInputValue("");
    setShowSlash(false);
    setShowMention(false);
  }, [inputValue, isStreaming, attachedFiles, selectedModel, mode, dispatch]);

  const handleStop = useCallback(() => {
    postMessage({ type: "stop" });
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isStreaming) handleSend();
    }
    if (e.key === "Escape" && isStreaming) {
      e.preventDefault();
      handleStop();
    }
    if (e.key === "ArrowUp" && inputValue === "" && inputHistory.length > 0) {
      e.preventDefault();
      dispatch({ type: "NAVIGATE_HISTORY", direction: "up" });
    }
    if (e.key === "ArrowDown" && historyIndex >= 0) {
      e.preventDefault();
      dispatch({ type: "NAVIGATE_HISTORY", direction: "down" });
    }
  }, [inputValue, isStreaming, inputHistory, historyIndex, handleSend, handleStop, dispatch]);

  const handleInput = useCallback((e: Event) => {
    const val = (e.target as HTMLTextAreaElement).value;
    setInputValue(val);
    autoResize();

    // Slash popup
    if (val.startsWith("/") && (!val.includes(" ") || val.startsWith("/mode"))) {
      const matches = SLASH_COMMANDS.filter(c => c.cmd.startsWith(val));
      setSlashMatches(matches);
      setShowSlash(matches.length > 0);
    } else {
      setShowSlash(false);
    }

    // @-mention
    const cursor = (e.target as HTMLTextAreaElement).selectionStart;
    const before = val.slice(0, cursor);
    const atIdx = before.lastIndexOf("@");
    if (atIdx >= 0 && (atIdx === 0 || before[atIdx - 1] === " " || before[atIdx - 1] === "\n")) {
      const query = before.slice(atIdx + 1);
      if (query.length >= 2 && !query.includes(" ")) {
        if (mentionTimeoutRef.current) clearTimeout(mentionTimeoutRef.current);
        mentionTimeoutRef.current = setTimeout(() => {
          postMessage({ type: "searchFiles", query });
        }, 200);
        setShowMention(true);
      } else {
        setShowMention(false);
      }
    } else {
      setShowMention(false);
    }
  }, [autoResize]);

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const pasted = e.clipboardData?.getData("text") ?? "";
    if (pasted.trim().length > 1) {
      postMessage({ type: "pastePath", path: pasted.trim() });
    }
  }, []);

  const handleSlashSelect = useCallback((cmd: string) => {
    setInputValue(cmd);
    setShowSlash(false);
    // Auto-execute
    setTimeout(() => {
      const parts = cmd.split(/\s+/);
      const c = parts[0].toLowerCase();
      if (c === "/new" || c === "/clear") {
        dispatch({ type: "RESET_CHAT" });
        postMessage({ type: "session:new" });
        setInputValue("");
      } else if (c === "/mode") {
        const m = (parts[1] ?? "").trim();
        if (["code", "architect", "ask", "askonwrite"].includes(m)) {
          dispatch({ type: "SET_MODE", mode: m });
          postMessage({ type: "setMode", mode: m });
          setInputValue("");
        }
      } else if (c === "/history") {
        dispatch({ type: "TOGGLE_DRAWER", open: true });
        postMessage({ type: "session:list" });
        setInputValue("");
      }
    }, 0);
  }, [dispatch]);

  const handleMentionSelect = useCallback((file: FileSearchResult) => {
    const el = inputRef.current;
    if (!el) return;
    const cursor = el.selectionStart;
    const before = inputValue.slice(0, cursor);
    const atIdx = before.lastIndexOf("@");
    if (atIdx >= 0) {
      const newVal = inputValue.slice(0, atIdx) + "@" + file.name + " " + inputValue.slice(cursor);
      setInputValue(newVal);
    }
    // Attach file
    if (!attachedFiles.some(a => a.path === file.path)) {
      dispatch({ type: "FILES_ATTACHED", files: [{ path: file.path, name: file.name }] });
      postMessage({ type: "pickFileByPath", path: file.path });
    }
    setShowMention(false);
  }, [inputValue, attachedFiles, dispatch]);

  return (
    <div class="input-wrapper">
      {/* File chips */}
      {attachedFiles.length > 0 && (
        <div class="file-chips">
          {attachedFiles.map((f, idx) => (
            <span class="file-chip" key={f.path}>
              <span class="chip-name" title={f.path}>{f.name}</span>
              <span class="chip-remove" onClick={() => { dispatch({ type: "REMOVE_FILE", index: idx }); }}>x</span>
            </span>
          ))}
        </div>
      )}

      {/* Slash popup */}
      {showSlash && slashMatches.length > 0 && (
        <div class="slash-popup visible">
          {slashMatches.map(item => (
            <div
              class="slash-popup-item"
              key={item.cmd}
              onMouseDown={(e) => { e.preventDefault(); handleSlashSelect(item.cmd); }}
            >
              <strong>{item.cmd}</strong>
              <span style="opacity:0.6">{item.desc}</span>
            </div>
          ))}
        </div>
      )}

      {/* @-mention popup */}
      {showMention && mentionResults.length > 0 && (
        <div class="mention-popup visible">
          {mentionResults.map(f => (
            <div
              class="mention-item"
              key={f.path}
              onMouseDown={(e) => { e.preventDefault(); handleMentionSelect(f); }}
            >
              <span class="mention-name">{f.name}</span>
              <span class="mention-path">{f.path}</span>
            </div>
          ))}
        </div>
      )}

      <div class="input-area">
        <button
          class="attach-btn"
          title="Attach files"
          aria-label="Attach files"
          onClick={() => { postMessage({ type: "pickFiles" }); }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <textarea
          ref={inputRef}
          placeholder="Describe a task..."
          rows={1}
          aria-label="Message input"
          value={inputValue}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => { setTimeout(() => { setShowSlash(false); setShowMention(false); }, 150); }}
        />
        {isStreaming ? (
          <button
            class="stop-btn"
            aria-label="Stop"
            title="Stop (Escape)"
            onClick={handleStop}
          >
            <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
          </button>
        ) : (
          <button
            class={`send-btn${inputValue.trim() ? " active" : ""}`}
            aria-label="Send message"
            title="Send (Enter)"
            onClick={handleSend}
            disabled={!inputValue.trim()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        )}
      </div>
    </div>
  );
}
