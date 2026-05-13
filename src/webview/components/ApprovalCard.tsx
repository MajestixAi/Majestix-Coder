import type { ApprovalState } from "../types";
import { escapeHtml, postMessage } from "../utils";
import type { Action } from "../state";
import { CopyButton } from "./CopyButton";

interface Props {
  id: string;
  approval: ApprovalState;
  dispatch: (action: Action) => void;
}

export function ApprovalCard({ id, approval, dispatch }: Props) {
  const handleApproval = (approved: boolean) => {
    dispatch({ type: "APPROVAL_RESOLVE", approved });
    postMessage({ type: "approvalResponse", approved });
  };

  const handleAllowAll = () => {
    dispatch({ type: "START_AUTO_APPROVE_TIMER", durationMs: 10 * 60 * 1000 });
    handleApproval(true);
  };

  const handleToggle = () => {
    dispatch({ type: "TOGGLE_ITEM_COLLAPSED", itemId: id });
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

  const hasDetail = !!approval.detail;
  const collapsed = approval.collapsed ?? true;
  const detail = approval.detail ?? "";

  return (
    <div class="tool-card approval-card">
      <div class="tool-header" onClick={hasDetail ? handleToggle : undefined}>
        <span class="icon">{"\u26a0\ufe0f"}</span>
        <span class="name">{approval.toolName}</span>
        <span class="desc">{approval.description}</span>
        {hasDetail && (
          <span class="toggle">{collapsed ? "\u25bc" : "\u25b2"}</span>
        )}
      </div>
      {hasDetail && (
        <div class={`approval-body ${collapsed ? "collapsed" : ""}`}>
          <pre
            class="approval-diff"
            dangerouslySetInnerHTML={{ __html: renderDiff(detail) }}
          />
        </div>
      )}
      <div class="approval-bar">
        <button class="btn-approve" onClick={() => { handleApproval(true); }}>Allow</button>
        <button class="btn-allow-all" onClick={handleAllowAll}>{"✅"} Allow All (10 min)</button>
        <button class="btn-reject" onClick={() => { handleApproval(false); }}>Reject</button>
        {hasDetail && (
          <>
            <button
              class="approval-view-diff-btn"
              onClick={() => {
                postMessage({ type: "viewDiff", toolName: approval.toolName });
              }}
            >{"🔍"} View Diff</button>
            <CopyButton getText={() => approval.detail ?? ""} className="approval-copy-btn" />
          </>
        )}
      </div>
    </div>
  );
}
