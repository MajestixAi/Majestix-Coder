
import { useRef, useEffect } from "preact/hooks";
import type { ConversationItem, ToolCardState } from "../types";
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

  const processedItems = processTurns(items);

  const rendered = processedItems.map(item => renderItem(item, lastSentMessage, dispatch));

  if (isStreaming && items.length > 0) {
    const lastItem = items[items.length - 1];
    const showTyping = lastItem.kind === "turn-start" || lastItem.kind === "user" || lastItem.kind === "thinking";
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

function processTurns(items: ConversationItem[]): ConversationItem[] {
  const processed: ConversationItem[] = [];
  let currentTurn: ConversationItem[] = [];

  const flushTurn = () => {
    if (currentTurn.length > 0) {
      const toolCalls = new Map<string, ConversationItem>();
      const toolResults = new Map<string, ConversationItem>();

      for (const item of currentTurn) {
        if (item.kind === "tool-call") {
          toolCalls.set(item.tool.id, item);
        } else if (item.kind === "tool-result") {
          toolResults.set(item.toolId, item);
        }
      }

      for (const item of currentTurn) {
        if (item.kind === "tool-call" && toolResults.has(item.tool.id)) {
          const resultItem = toolResults.get(item.tool.id) as Extract<ConversationItem, { kind: "tool-result" }>;
          const updatedTool: ToolCardState = {
            ...item.tool,
            result: resultItem.content,
            isError: resultItem.isError,
          };
          processed.push({ ...item, tool: updatedTool });
        } else if (item.kind !== "tool-result") {
          processed.push(item);
        }
      }
      currentTurn = [];
    }
  };

  for (const item of items) {
    if (item.kind === "user") {
      flushTurn();
      processed.push(item);
    } else if (item.kind === "turn-start") {
      flushTurn();
      processed.push(item);
    } else {
      currentTurn.push(item);
    }
  }
  flushTurn();

  return processed;
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

    case "approval":
      return <ApprovalCard key={item.id} id={item.id} approval={item.approval} dispatch={dispatch} />;

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
          {" · "}
          <span class="credits-amount">{item.credits.toFixed(2)} cr</span>
        </div>
      );

    case "file-edit": {
      const opLabel = item.op === "write" ? "Created" : item.op === "edit" ? "Edited" : "Patched";
      return (
        <div class="file-edit-notice" key={item.id}>
          <span class="file-edit-icon">✏️</span>
          <span class="file-edit-op">{opLabel}</span>
          <code class="file-edit-path">{item.path}</code>
          <CopyButton getText={() => item.path} className="file-edit-copy-btn" />
        </div>
      );
    }

    case "garble-warning":
      return (
        <div class="error-msg error-context" key={item.id} style={{ marginTop: "4px" }}>
          <strong>Model Compatibility Issue</strong><br />
          The selected model is outputting unrecognized tool-call syntax. For agentic tasks (Code mode),
          please select Claude Sonnet, GPT-4o, or another tool-capable model from the dropdown.
        </div>
      );

    case "turn-start":
      return <div key={item.id} class="ai-turn"></div>;

    default:
      return <span key={(item as { id: string }).id} />;
  }
}
