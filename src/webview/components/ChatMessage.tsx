import { useRef, useEffect, useCallback } from "preact/hooks";
import { renderMarkdown } from "../utils";
import { CopyButton } from "./CopyButton";

interface Props {
  role: "user" | "assistant";
  content: string;
}

/**
 * Chat message bubble. For assistant messages, renders markdown via direct
 * innerHTML assignment on a persistent DOM ref — identical to the old monolith
 * approach. Preact only manages the wrapper structure; the bubble content
 * bypasses the virtual DOM entirely to avoid reconciliation overhead during
 * high-frequency streaming updates.
 */
export function ChatMessage({ role, content }: Props) {
  const bubbleRef = useRef<HTMLDivElement>(null);

  // Direct DOM mutation — same as the original:
  //   currentAssistantEl.innerHTML = renderMarkdown(currentContent);
  // Runs on every content change. Preact never touches the bubble's children.
  useEffect(() => {
    if (role !== "assistant" || !bubbleRef.current) return;

    // Set innerHTML directly — bypass Preact vdom
    bubbleRef.current.innerHTML = renderMarkdown(content);

    // Inject copy buttons into code block headers (rendered by markdown.ts custom renderer)
    const wrappers = bubbleRef.current.querySelectorAll(".code-block-wrapper");
    wrappers.forEach(wrapper => {
      const header = wrapper.querySelector(".code-block-header");
      if (!header || header.querySelector(".copy-btn")) return;
      const pre = wrapper.querySelector("pre");
      const btn = document.createElement("button");
      btn.className = "copy-btn code-copy-btn";
      btn.innerHTML = "<svg viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"9\" y=\"2\" width=\"6\" height=\"4\" rx=\"1\"/><path d=\"M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2\"/></svg><span>Copy</span>";
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const code = pre?.querySelector("code");
        const text = code ? code.textContent : pre?.textContent;
        (globalThis as unknown as { vscodeApi: { postMessage(msg: unknown): void } }).vscodeApi.postMessage({ type: "copyToClipboard", content: text ?? "" });
        btn.innerHTML = "<svg viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"20 6 9 17 4 12\"/></svg><span>Copied</span>";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.innerHTML = "<svg viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"9\" y=\"2\" width=\"6\" height=\"4\" rx=\"1\"/><path d=\"M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2\"/></svg><span>Copy</span>";
          btn.classList.remove("copied");
        }, 1500);
      });
      header.appendChild(btn);
    });
  }, [content, role]);

  const getText = useCallback(() => {
    return bubbleRef.current?.innerText ?? bubbleRef.current?.textContent ?? "";
  }, []);

  if (role === "user") {
    return (
      <div class="msg msg-user">
        <div class="bubble">{content}</div>
      </div>
    );
  }

  // Empty div — Preact renders the shell, useEffect owns the innerHTML.
  // This matches the old monolith: ensureAssistantBubble() created an empty
  // div, then the message handler set .innerHTML on every chunk.
  return (
    <div class="msg msg-ai">
      <div class="bubble" ref={bubbleRef} />
      {content && (
        <div class="msg-actions">
          <CopyButton getText={getText} />
        </div>
      )}
    </div>
  );
}
