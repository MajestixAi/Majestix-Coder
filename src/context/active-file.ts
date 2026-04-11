import * as vscode from "vscode";

export interface ActiveFileContext {
  filePath: string;
  language: string;
  content: string;
  selection?: {
    start: number;
    end: number;
    text: string;
  };
  diagnostics: DiagnosticInfo[];
}

export interface DiagnosticInfo {
  message: string;
  severity: string;
  line: number;
  source?: string;
}

const MAX_FILE_SIZE = 50_000;

// Track recently edited files for workspace context
const recentlyEditedFiles: { path: string; timestamp: number }[] = [];
const MAX_RECENT_FILES = 10;

/**
 * Call this from the extension activation to start tracking file edits.
 *
 * @returns A disposable that stops tracking when disposed.
 */
export function startTrackingEdits(): vscode.Disposable {
  return vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.scheme !== "file") {return;}
    if (e.contentChanges.length === 0) {return;}
    const relPath = vscode.workspace.asRelativePath(e.document.uri);
    // Remove existing entry for this file
    const idx = recentlyEditedFiles.findIndex(f => f.path === relPath);
    if (idx >= 0) {recentlyEditedFiles.splice(idx, 1);}
    // Add to front
    recentlyEditedFiles.unshift({ path: relPath, timestamp: Date.now() });
    // Trim
    if (recentlyEditedFiles.length > MAX_RECENT_FILES) {recentlyEditedFiles.pop();}
  });
}

/**
 * Get recently edited file paths (last 10 minutes).
 *
 * @returns An array of relative file paths edited in the last 10 minutes.
 */
export function getRecentlyEditedFiles(): string[] {
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  return recentlyEditedFiles
    .filter(f => f.timestamp >= tenMinutesAgo)
    .map(f => f.path);
}

/**
 * Collect context from the active editor: file content, selection, diagnostics.
 *
 * @returns The active file context, or null if no editor is active.
 */
export function getActiveFileContext(): ActiveFileContext | null {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {return null;}

  const doc = editor.document;
  const relativePath =
    vscode.workspace.asRelativePath(doc.uri) || doc.fileName;

  let content = doc.getText();
  if (content.length > MAX_FILE_SIZE) {
    content = content.slice(0, MAX_FILE_SIZE) + "\n[truncated]";
  }

  let selection: ActiveFileContext["selection"];
  if (!editor.selection.isEmpty) {
    const sel = editor.selection;
    selection = {
      start: sel.start.line + 1,
      end: sel.end.line + 1,
      text: doc.getText(sel),
    };
  }

  const rawDiags = vscode.languages.getDiagnostics(doc.uri);
  const diagnostics: DiagnosticInfo[] = rawDiags
    .filter(
      (d) =>
        d.severity === vscode.DiagnosticSeverity.Error ||
        d.severity === vscode.DiagnosticSeverity.Warning
    )
    .slice(0, 10)
    .map((d) => ({
      message: d.message,
      severity:
        d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
      line: d.range.start.line + 1,
      source: d.source,
    }));

  return {
    filePath: relativePath,
    language: doc.languageId,
    content,
    selection,
    diagnostics,
  };
}

/**
 * Get workspace-wide diagnostics (errors and warnings from the Problems panel).
 * Returns up to 20 diagnostics across all files.
 *
 * @returns An array of diagnostic objects from across the workspace.
 */
export function getWorkspaceDiagnostics(): {
  filePath: string;
  line: number;
  severity: string;
  message: string;
  source?: string;
}[] {
  const allDiags = vscode.languages.getDiagnostics();
  const results: { filePath: string; line: number; severity: string; message: string; source?: string }[] = [];

  for (const [uri, diags] of allDiags) {
    if (results.length >= 20) {break;}
    const relPath = vscode.workspace.asRelativePath(uri);
    for (const d of diags) {
      if (results.length >= 20) {break;}
      if (d.severity !== vscode.DiagnosticSeverity.Error && d.severity !== vscode.DiagnosticSeverity.Warning) {continue;}
      results.push({
        filePath: relPath,
        line: d.range.start.line + 1,
        severity: d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
        message: d.message,
        source: d.source,
      });
    }
  }

  return results;
}

/**
 * Get just the selected text from the active editor, or null if nothing selected.
 *
 * @returns An object with the selected text and metadata, or null if no selection exists.
 */
export function getSelectedText(): {
  text: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
} | null {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.selection.isEmpty) {return null;}

  const doc = editor.document;
  const sel = editor.selection;

  return {
    text: doc.getText(sel),
    filePath: vscode.workspace.asRelativePath(doc.uri),
    language: doc.languageId,
    startLine: sel.start.line + 1,
    endLine: sel.end.line + 1,
  };
}
