import type { ApprovalState } from "../types";
import { escapeHtml, postMessage } from "../utils";
import type { Action } from "../state";
import { CopyButton } from "./CopyButton";

interface Props {
  approval: ApprovalState;
  dispatch: (action: Action) => void;
}

export function ApprovalCard({ approval, dispatch }: Props) {
  const handleApproval = (approved: boolean) => {
    dispatch({ type: "APPROVAL_RESOLVE", approved });
    postMessage({ type: "approvalResponse", approved });
  };

  const handleAllowAll = () => {
    dispatch({ type: "START_AUTO_APPROVE_TIMER", durationMs: 10 * 60 * 1000 });
    handleApproval(true);
  };

  // Color diff lines
  const renderDiff = (detail: string) => {
    return detail.split("\n").map(line => {
      if (line.startsWith("+")) return `<span style="color:var(--vscode-gitDecoration-addedResourceForeground,#4ec94e);">${escapeHtml(line)}</span>`;
      if (line.startsWith("-")) return `<span style="color:var(--vscode-gitDecoration-deletedResourceForeground,#f44);">${escapeHtml(line)}</span>`;
      return escapeHtml(line);
    }).join("\n");
  };

  if (approval.resolved) {
    return (
      <div class="tool-card approval-card">
        <div class="tool-header">
          <span class="icon">{approval.approved ? "\u2705" : "\u274c"}</span>
          <span class="name">{approval.toolName}</span>
          <span class="desc">{approval.description}</span>
        </div>
        <div class="approval-bar">
          <span style="padding:4px 10px;font-size:12px;">
            {approval.approved ? "Allowed" : "Rejected"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div class="tool-card approval-card">
      <div class="tool-header">
        <span class="icon">{"\u26a0\ufe0f"}</span>
        <span class="name">{approval.toolName}</span>
        <span class="desc">{approval.description}</span>
        {approval.detail && (
          <pre
            class="approval-diff"
            dangerouslySetInnerHTML={{ __html: renderDiff(approval.detail) }}
          />
        )}
      </div>
      <div class="approval-bar">
        <button class="btn-approve" onClick={() => { handleApproval(true); }}>Allow</button>
        <button class="btn-allow-all" onClick={handleAllowAll}>{"\u2705"} Allow All (10 min)</button>
        <button class="btn-reject" onClick={() => { handleApproval(false); }}>Reject</button>
        {approval.detail && (
          <CopyButton getText={() => approval.detail ?? ""} className="approval-copy-btn" />
        )}
      </div>
    </div>
  );
}
