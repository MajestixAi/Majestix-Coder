import * as vscode from "vscode";

import { stashBackup } from "./file-backup";
import { detectLineEnding, restoreLineEndings } from "./diff-match";
import { resolveWorkspacePath } from "../util/path-safety";
import type {
  ToolContext,
  ToolHandler,
  ToolResult,
} from "./types";

/** Delay after write to let VSCode language server report diagnostics. */
const POST_WRITE_DIAGNOSTIC_DELAY_MS = 300;

export const writeToFileTool: ToolHandler = {
  definition: {
    name: "write_to_file",
    description:
      "Create a new file or overwrite an existing file with the provided content. " +
      "The user will see a diff and must approve before the file is written. " +
      "Always provide the COMPLETE file content — do not use placeholders or truncation.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root",
        },
        content: {
          type: "string",
          description: "The full file content to write",
        },
      },
      required: ["path", "content"],
    },
  },

  requiresApproval: () => true,

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const filePath = input.path as string;
    const newContent = input.content as string;
    let uri: vscode.Uri;
    try {
      uri = resolveWorkspacePath(context.workspaceRoot, filePath);
    } catch (e: unknown) {
      return {
        tool_use_id: "",
        content: `Invalid path: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
      };
    }

    // Read existing content (if any) for diff display and line ending detection
    let oldContent = "";
    let isNew = false;
    let originalLineEnding: "\n" | "\r\n" = "\n";
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      oldContent = new TextDecoder().decode(bytes);
      originalLineEnding = detectLineEnding(oldContent);
    } catch {
      isNew = true;
    }

    // Stash backup before modifying (for rollback capability)
    await stashBackup(uri);

    // Ensure parent directory exists
    const parentUri = vscode.Uri.joinPath(uri, "..");
    try {
      await vscode.workspace.fs.createDirectory(parentUri);
    } catch {
      // directory may already exist
    }

    // Preserve original line endings if updating an existing file
    const finalContent = isNew ? newContent : restoreLineEndings(newContent, originalLineEnding);

    // Write the file
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(finalContent));

    // Wait briefly for VSCode diagnostics to catch up, then collect any new errors
    const diagnosticFeedback = await collectPostWriteDiagnostics(uri, POST_WRITE_DIAGNOSTIC_DELAY_MS);

    // Build result summary
    if (isNew) {
      const lineCount = newContent.split("\n").length;
      return {
        tool_use_id: "",
        content: `Created new file: ${filePath} (${String(lineCount)} lines)${diagnosticFeedback}`,
      };
    }

    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const added = newLines.length - oldLines.length;
    const desc = added >= 0 ? `+${String(added)} lines` : `${String(added)} lines`;

    return {
      tool_use_id: "",
      content: `Updated ${filePath} (${String(oldLines.length)} → ${String(newLines.length)} lines, ${desc})${diagnosticFeedback}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Post-write diagnostics collection
// ---------------------------------------------------------------------------

/**
 * Wait for VSCode's language server to report diagnostics on the file,
 * then return a summary of any errors/warnings introduced.
 * This gives the agent immediate feedback if a write introduced type errors, etc.
 *
 * @param uri - The VSCode URI of the file to check diagnostics for.
 * @param delayMs - Milliseconds to wait before checking diagnostics.
 * @returns A formatted string with diagnostic errors/warnings, or empty string.
 */
async function collectPostWriteDiagnostics(
  uri: vscode.Uri,
  delayMs: number
): Promise<string> {
  await new Promise(resolve => setTimeout(resolve, delayMs));

  const diagnostics = vscode.languages.getDiagnostics(uri);
  if (diagnostics.length === 0) { return ""; }

  const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
  const warnings = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);

  if (errors.length === 0 && warnings.length === 0) { return ""; }

  const parts: string[] = ["\n\n📋 Post-write diagnostics:"];

  // Show up to 5 errors
  for (const err of errors.slice(0, 5)) {
    parts.push(`  ERROR line ${String(err.range.start.line + 1)}: ${err.message}`);
  }
  if (errors.length > 5) {
    parts.push(`  ... and ${String(errors.length - 5)} more error(s)`);
  }

  // Show up to 3 warnings
  for (const warn of warnings.slice(0, 3)) {
    parts.push(`  WARN line ${String(warn.range.start.line + 1)}: ${warn.message}`);
  }
  if (warnings.length > 3) {
    parts.push(`  ... and ${String(warnings.length - 3)} more warning(s)`);
  }

  if (errors.length > 0) {
    parts.push("\n⚠️ Fix the errors above before proceeding.");
  }

  return parts.join("\n");
}
