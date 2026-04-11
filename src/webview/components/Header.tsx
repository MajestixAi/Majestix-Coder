import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import type { ModelInfo } from "../types";
import type { Action } from "../state";
import { postMessage, generateDownloadContent } from "../utils";
import type { ConversationItem } from "../types";

interface Props {
  mode: string;
  selectedModel: string;
  models: ModelInfo[];
  thinkingEnabled: boolean;
  hasMessages: boolean;
  items: ConversationItem[];
  keyStatus: { hasKey: boolean; maskedKey: string };
  autoApproveUntil: number;
  dispatch: (action: Action) => void;
}

export function Header({
  mode, selectedModel, models, thinkingEnabled, hasMessages, items,
  keyStatus, autoApproveUntil, dispatch,
}: Props) {
  const [keyMenuOpen, setKeyMenuOpen] = useState(false);
  const [timerText, setTimerText] = useState("");
  const keyBtnRef = useRef<HTMLButtonElement>(null);

  // Close key menu on outside click
  useEffect(() => {
    const handler = () => { setKeyMenuOpen(false); };
    document.addEventListener("click", handler);
    return () => { document.removeEventListener("click", handler); };
  }, []);

  // Auto-approve timer tick
  useEffect(() => {
    if (autoApproveUntil <= 0) { setTimerText(""); return; }
    const tick = () => {
      const remaining = autoApproveUntil - Date.now();
      if (remaining <= 0) { setTimerText(""); return; }
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      setTimerText("\u2705 Auto-allow " + (mins > 0 ? String(mins) + "m " : "") + String(secs) + "s");
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => { clearInterval(interval); };
  }, [autoApproveUntil]);

  const handleDownload = useCallback(() => {
    if (!hasMessages) return;
    const content = generateDownloadContent(items as { kind: string; [key: string]: unknown }[], selectedModel);
    postMessage({ type: "downloadChat", content });
  }, [hasMessages, items, selectedModel]);

  // Group models by provider
  const byProvider: Record<string, ModelInfo[]> = {};
  for (const m of models) {
    const p = m.provider || "Other";
    if (!(p in byProvider)) byProvider[p] = [];
    byProvider[p].push(m);
  }

  return (
    <div class="header">
      <button
        title="Session history"
        aria-label="Open session history"
        style="font-size:16px;"
        onClick={() => { dispatch({ type: "TOGGLE_DRAWER", open: true }); postMessage({ type: "session:list" }); }}
      >
        {"\u2630"}
      </button>

      <select
        id="modeSelect"
        value={mode}
        onChange={(e) => {
          const val = (e.target as HTMLSelectElement).value;
          dispatch({ type: "SET_MODE", mode: val });
          postMessage({ type: "setMode", mode: val });
        }}
      >
        <option value="code">Code</option>
        <option value="architect">Architect</option>
        <option value="ask">Ask</option>
        <option value="askonwrite">Ask+Write</option>
      </select>

      <button
        class={`thinking-toggle ${thinkingEnabled ? "active" : ""}`}
        title="Enable extended thinking"
        onClick={() => {
          dispatch({ type: "SET_THINKING_ENABLED", enabled: !thinkingEnabled });
          postMessage({ type: "setThinking", enabled: !thinkingEnabled });
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
        </svg>
        <span>Think</span>
      </button>

      <select
        id="modelSelect"
        value={selectedModel}
        title="Choose a model or let the platform auto-route"
        onChange={(e) => { dispatch({ type: "SET_MODEL", model: (e.target as HTMLSelectElement).value }); }}
      >
        <option value="">Auto (recommended)</option>
        {Object.entries(byProvider).map(([provider, providerModels]) => (
          <optgroup label={provider.charAt(0).toUpperCase() + provider.slice(1)} key={provider}>
            {providerModels.map(m => {
              let label = m.display_name;
              if (m.context_window > 0) label += ` (${Math.round(m.context_window / 1000)}K)`;
              const chatOnly = mode === "code" && m.supports_tools === false;
              if (chatOnly) label += " (chat only)";
              return <option value={m.key} key={m.key} disabled={chatOnly}>{label}</option>;
            })}
          </optgroup>
        ))}
      </select>

      {hasMessages && (
        <button title="Download chat" onClick={handleDownload}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      )}

      <button
        class="key-btn"
        ref={keyBtnRef}
        title="API Key"
        aria-label="API Key settings"
        onClick={(e) => {
          e.stopPropagation();
          setKeyMenuOpen(!keyMenuOpen);
          if (!keyMenuOpen) postMessage({ type: "keyStatus" });
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </svg>
        <span class={`key-dot ${keyStatus.hasKey ? "set" : "unset"}`} />
        <div class={`key-menu ${keyMenuOpen ? "open" : ""}`} onClick={(e) => { e.stopPropagation(); }}>
          <div class="key-menu-status">
            {keyStatus.hasKey ? `Key: ${keyStatus.maskedKey || "set"}` : "No API key set"}
          </div>
          <div class="key-menu-item" onClick={() => { setKeyMenuOpen(false); postMessage({ type: "keySet" }); }}>
            Set API Key
          </div>
          <div class="key-menu-item" onClick={() => { setKeyMenuOpen(false); postMessage({ type: "keyClear" }); }}>
            Clear API Key
          </div>
        </div>
      </button>

      <button
        title="New chat"
        aria-label="Start new chat"
        onClick={() => { dispatch({ type: "RESET_CHAT" }); }}
      >+</button>

      <button
        title="Extension settings"
        aria-label="Open Majestix settings"
        onClick={() => { postMessage({ type: "openSettings" }); }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {timerText && <span class="auto-approve-badge">{timerText}</span>}
    </div>
  );
}
