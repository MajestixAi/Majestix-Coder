import { useState, useCallback } from "preact/hooks";
import { postMessage } from "../utils";

const ICON_CLIPBOARD = "<svg viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"9\" y=\"2\" width=\"6\" height=\"4\" rx=\"1\"/><path d=\"M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2\"/></svg>";
const ICON_CHECK = "<svg viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"20 6 9 17 4 12\"/></svg>";

interface Props {
  getText: () => string;
  className?: string;
}

export function CopyButton({ getText, className }: Props) {
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback((e: Event) => {
    e.stopPropagation();
    postMessage({ type: "copyToClipboard", content: getText() });
    setCopied(true);
    setTimeout(() => { setCopied(false); }, 1500);
  }, [getText]);

  return (
    <button
      class={`copy-btn ${copied ? "copied" : ""} ${className ?? ""}`}
      onClick={handleClick}
      dangerouslySetInnerHTML={{
        __html: (copied ? ICON_CHECK : ICON_CLIPBOARD) + `<span>${copied ? "Copied" : "Copy"}</span>`,
      }}
    />
  );
}
