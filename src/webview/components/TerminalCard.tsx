import type { ToolCardState } from "../types";
import { CopyButton } from "./CopyButton";

interface Props {
  tool: ToolCardState;
  onToggle: () => void;
}

export function TerminalCard({ tool, onToggle }: Props) {
  const command = (tool.input.command as string | undefined) ?? tool.input.cmd as string | undefined ?? "";
  const hasResult = tool.result !== undefined;
  const displayResult = tool.result && tool.result.length > 2000
    ? tool.result.slice(0, 2000) + "\n... [" + String(tool.result.length) + " chars]"
    : tool.result;

  return (
    <div class={`terminal-card ${tool.isError ? "error" : ""}`}>
      <div class="terminal-header" onClick={onToggle}>
        <span class="terminal-prompt">$</span>
        <span class="terminal-command">{command}</span>
        {hasResult && (
          <span class={`tool-status ${tool.isError ? "status-error" : "status-ok"}`}>
            {tool.isError ? "\u2716 Failed" : "\u2714 Done"}
          </span>
        )}
        <CopyButton getText={() => command} className="terminal-cmd-copy-btn" />
        <span class="toggle">{tool.collapsed ? "\u25bc" : "\u25b2"}</span>
      </div>
      <div class={`terminal-body ${tool.collapsed ? "collapsed" : ""}`}>
        <pre class="terminal-output">{displayResult ?? "Running..."}</pre>
        {hasResult && tool.result && (
          <CopyButton getText={() => tool.result ?? ""} className="terminal-output-copy-btn" />
        )}
      </div>
    </div>
  );
}
