import type { ToolCardState } from "../types";
import { toolIcon, toolDescription } from "../utils";
import { CopyButton } from "./CopyButton";

interface Props {
  tool: ToolCardState;
  onToggle: () => void;
}

export function ToolCard({ tool, onToggle }: Props) {
  const icon = toolIcon(tool.name);
  const desc = toolDescription(tool.name, tool.input);
  const hasResult = tool.result !== undefined;
  const displayResult = tool.result && tool.result.length > 2000
    ? tool.result.slice(0, 2000) + "\n... [" + String(tool.result.length) + " chars]"
    : tool.result;

  return (
    <div class={`tool-card ${tool.isError ? "error" : ""}`}>
      <div class="tool-header" onClick={onToggle}>
        <span class="icon">{icon}</span>
        <span class="name">{tool.name}</span>
        <span class="desc">{desc}</span>
        {hasResult && (
          <span class={`tool-status ${tool.isError ? "status-error" : "status-ok"}`}>
            {tool.isError
              ? "\u2716 Failed"
              : "\u2714 " + (tool.result ? tool.result.split("\n")[0].slice(0, 50) : "Done")}
          </span>
        )}
        <span class="toggle">{tool.collapsed ? "\u25bc" : "\u25b2"}</span>
      </div>
      <div class={`tool-body ${tool.collapsed ? "collapsed" : ""}`}>
        {displayResult ?? "Running..."}
        {hasResult && tool.result && (
          <CopyButton getText={() => tool.result ?? ""} className="tool-result-copy-btn" />
        )}
      </div>
    </div>
  );
}
