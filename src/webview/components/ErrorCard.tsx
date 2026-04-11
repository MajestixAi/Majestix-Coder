import { classifyError, postMessage } from "../utils";
import type { Action } from "../state";
import { CopyButton } from "./CopyButton";

interface Props {
  message: string;
  lastSentMessage: { text: string; model?: string; files: { path: string; name: string }[] } | null;
  dispatch: (action: Action) => void;
}

export function ErrorCard({ message, lastSentMessage, dispatch }: Props) {
  const { title, detail, cssClass } = classifyError(message);

  const handleRetry = () => {
    if (!lastSentMessage) return;
    dispatch({ type: "STREAM_START", text: lastSentMessage.text, model: lastSentMessage.model, files: lastSentMessage.files });
    postMessage({
      type: "sendAgent",
      message: lastSentMessage.text,
      model: lastSentMessage.model,
      attachedFiles: lastSentMessage.files,
    });
  };

  return (
    <div class={`error-msg ${cssClass}`}>
      <div class="error-header">
        <strong>{title}</strong>
        <CopyButton getText={() => `${title}\n${detail}`} className="error-copy-btn" />
      </div>
      <br />
      {detail}
      {lastSentMessage && (
        <button class="retry-btn" onClick={handleRetry}>Retry</button>
      )}
    </div>
  );
}
