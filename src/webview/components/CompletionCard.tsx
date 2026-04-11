import { renderMarkdown } from "../utils";
import { CopyButton } from "./CopyButton";

interface Props {
  result: string;
  command?: string;
}

export function CompletionCard({ result, command }: Props) {
  return (
    <div class="completion-card">
      <div class="completion-header">
        <div class="title">Task Complete</div>
        <CopyButton getText={() => (command ? result + "\n\n" + command : result)} className="completion-copy-btn" />
      </div>
      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(result) }} />
      {command && <br />}
      {command && (
        <div class="completion-command-row">
          <code>{command}</code>
          <CopyButton getText={() => command} className="command-copy-btn" />
        </div>
      )}
    </div>
  );
}
