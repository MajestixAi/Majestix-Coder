import { useRef, useEffect } from "preact/hooks";
import type { ConversationItem } from "../types";
import type { Action, AppState } from "../state";
import { ChatMessage } from "./ChatMessage";
import { ToolCard } from "./ToolCard";
import { TerminalCard } from "./TerminalCard";
import { ApprovalCard } from "./ApprovalCard";
import { ThinkingBlock } from "./ThinkingBlock";
import { CompletionCard } from "./CompletionCard";
import { ErrorCard } from "./ErrorCard";
import { Welcome } from "./Welcome";
import { CopyButton } from "./CopyButton";
// All rendering handled by sub-components

interface Props {
  items: ConversationItem[];
  hasMessages: boolean;
  isStreaming: boolean;
  lastSentMessage: AppState["lastSentMessage"];
  logoUri: string;
  dispatch: (action: Action) => void;
}

export function ConversationView({ items, hasMessages, isStreaming, lastSentMessage, logoUri, dispatch }: Props) {
  const messagesRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (messagesRef.current) {
      requestAnimationFrame(() => {
        if (messagesRef.current) {
          messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
        }
      });
    }
  }, [items]);

  if (!hasMessages) {
    return (
      <div id="messages" role="log" aria-label="Chat messages" aria-live="polite" ref={messagesRef}>
        <Welcome logoUri={logoUri} />
      </div>
    );
  }

  // Group items into turns: turn-start marks the beginning of an AI turn
  const rendered: preact.JSX.Element[] = [];
  let turnItems: ConversationItem[] = [];
  let inTurn = false;

  const flushTurn = () => {
    if (turnItems.length > 0) {
      const turnKey = turnItems[0].id;
      rendered.push(
        <div class="ai-turn" key={turnKey}>
          {turnItems.map(item => renderItem(item, lastSentMessage, dispatch))}
        </div>
      );
      turnItems = [];
    }
    inTurn = false;
  };

  for (const item of items) {
    if (item.kind === "user") {
      flushTurn();
      rendered.push(renderItem(item, lastSentMessage, dispatch));
    } else if (item.kind === "turn-start") {
      flushTurn();
      inTurn = true;
    } else if (inTurn) {
      turnItems.push(item);
    } else {
      // Standalone item (from session restore)
      rendered.push(renderItem(item, lastSentMessage, dispatch));
    }
  }
  flushTurn();

  // Typing indicator
  if (isStreaming && items.length > 0) {
    const lastItem = items[items.length - 1];
    const showTyping = lastItem.kind === "turn-start" ||
      lastItem.kind === "user" ||
      lastItem.kind === "thinking";
    if (showTyping) {
      rendered.push(
        <div class="typing-indicator" key="typing" role="status" aria-label="AI is thinking">
          <span class="typing-dot dot-1" />
          <span class="typing-dot dot-2" />
          <span class="typing-dot dot-3" />
        </div>
      );
    }
  }

  return (
    <div id="messages" role="log" aria-label="Chat messages" aria-live="polite" ref={messagesRef}>
      {rendered}
    </div>
  );
}

function renderItem(
  item: ConversationItem,
  lastSentMessage: AppState["lastSentMessage"],
  dispatch: (action: Action) => void,
): preact.JSX.Element {
  switch (item.kind) {
    case "user":
      return <ChatMessage key={item.id} role="user" content={item.text} />;

    case "ai-text":
      return <ChatMessage key={item.id} role="assistant" content={item.content} />;

    case "tool-call":
      if (item.tool.name === "execute_command" || item.tool.name === "bash" || item.tool.name === "run_command") {
        return (
          <TerminalCard
            key={item.id}
            tool={item.tool}
            onToggle={() => { dispatch({ type: "TOGGLE_ITEM_COLLAPSED", itemId: item.id }); }}
          />
        );
      }
      return (
        <ToolCard
          key={item.id}
          tool={item.tool}
          onToggle={() => { dispatch({ type: "TOGGLE_ITEM_COLLAPSED", itemId: item.id }); }}
        />
      );

    case "tool-result":
      return (
        <div class={`tool-card ${item.isError ? "error" : ""}`} key={item.id}>
          <div class="tool-header" onClick={() => { dispatch({ type: "TOGGLE_ITEM_COLLAPSED", itemId: item.id }); }}>
            <span class="icon">{item.isError ? "\u26a0\ufe0f" : "\u2705"}</span>
            <span class="name">Result</span>
            <span class="desc">{(item.content || "").slice(0, 60)}</span>
            {item.content && (
              <CopyButton getText={() => item.content || ""} className="tool-result-copy-btn" />
            )}
            <span class="toggle">{"\u25bc"}</span>
          </div>
          <div class="tool-body collapsed">{item.content}</div>
        </div>
      );

    case "approval":
      return <ApprovalCard key={item.id} approval={item.approval} dispatch={dispatch} />;

    case "thinking":
      return (
        <ThinkingBlock
          key={item.id}
          thinking={item.thinking}
          onToggle={() => { dispatch({ type: "TOGGLE_ITEM_COLLAPSED", itemId: item.id }); }}
        />
      );

    case "completion":
      return <CompletionCard key={item.id} result={item.result} command={item.command} />;

    case "error":
      return <ErrorCard key={item.id} message={item.message} lastSentMessage={lastSentMessage} dispatch={dispatch} />;

    case "credits":
      return (
        <div class="credits-info" key={item.id}>
          <span class="credits-model">{item.model}</span>
          {" \u00b7 "}
          <span class="credits-amount">{item.credits.toFixed(2)} cr</span>
        </div>
      );

    case "file-edit": {
      const opLabel = item.op === "write" ? "Created" : item.op === "edit" ? "Edited" : "Patched";
      return (
        <div class="file-edit-notice" key={item.id}>
          <span class="file-edit-icon">&#9998;</span>
          <span class="file-edit-op">{opLabel}</span>
          <code class="file-edit-path">{item.path}</code>
          <CopyButton getText={() => item.path} className="file-edit-copy-btn" />
        </div>
      );
    }

    case "garble-warning":
      return (
        <div class="error-msg error-context" key={item.id} style="margin-top:4px;">
          <strong>Model Compatibility Issue</strong><br />
          The selected model is outputting unrecognized tool-call syntax. For agentic tasks (Code mode),
          please select Claude Sonnet, GPT-4o, or another tool-capable model from the dropdown.
        </div>
      );

    case "turn-start":
      return <span key={item.id} />;

    default:
      return <span key={(item as { id: string }).id} />;
  }
}
