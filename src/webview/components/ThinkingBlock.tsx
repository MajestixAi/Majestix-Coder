import type { ThinkingState } from "../types";
import { useRef, useEffect } from "preact/hooks";
import { renderMarkdown } from "../utils";
import { CopyButton } from "./CopyButton";

interface Props {
  thinking: ThinkingState;
  onToggle: () => void;
}

export function ThinkingBlock({ thinking, onToggle }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Render markdown and auto-scroll — direct innerHTML like ChatMessage
  useEffect(() => {
    if (!bodyRef.current) return;
    bodyRef.current.innerHTML = renderMarkdown(thinking.content);
    if (thinking.streaming) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [thinking.content, thinking.streaming]);

  return (
    <div class={`thinking-block ${thinking.streaming ? "streaming" : ""}`}>
      <div class="thinking-header" onClick={onToggle}>
        <span class="thinking-icon">{"\ud83e\udde0"}</span>
        <span class="thinking-label">Thinking Trace</span>
        <button class="thinking-toggle-btn">
          {thinking.collapsed ? "Show" : "Hide"}
        </button>
        {!thinking.streaming && (
          <CopyButton getText={() => thinking.content} className="thinking-copy-btn" />
        )}
      </div>
      <div
        class={`thinking-body bubble ${thinking.collapsed ? "collapsed" : ""}`}
        ref={bodyRef}
      />
    </div>
  );
}
