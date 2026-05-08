import * as vscode from "vscode";

import {
  MAX_DIAGNOSTIC_ERRORS,
  MAX_DIAGNOSTIC_WARNINGS,
  POST_WRITE_DIAGNOSTIC_DELAY_MS,
} from "../constants";

/**
 * Wait for VSCode's language server to report diagnostics on the file,
 * then return a summary of any errors/warnings introduced.
 * This gives the agent immediate feedback if a write introduced type errors, etc.
 *
 * @param uri - The VSCode URI of the file to check diagnostics for.
 * @param delayMs - Milliseconds to wait before checking diagnostics.
 * @returns A formatted string with diagnostic errors/warnings, or empty string.
 */
export async function collectPostWriteDiagnostics(
  uri: vscode.Uri,
  delayMs: number = POST_WRITE_DIAGNOSTIC_DELAY_MS
): Promise<string> {
  await new Promise(resolve => setTimeout(resolve, delayMs));

  const diagnostics = vscode.languages.getDiagnostics(uri);
  if (diagnostics.length === 0) { return ""; }

  const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
  const warnings = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);

  if (errors.length === 0 && warnings.length === 0) { return ""; }

  const parts: string[] = ["\n\n📋 Post-write diagnostics:"];

  // Show up to N errors
  for (const err of errors.slice(0, MAX_DIAGNOSTIC_ERRORS)) {
    parts.push(`  ERROR line ${String(err.range.start.line + 1)}: ${err.message}`);
  }
  if (errors.length > MAX_DIAGNOSTIC_ERRORS) {
    parts.push(`  ... and ${String(errors.length - MAX_DIAGNOSTIC_ERRORS)} more error(s)`);
  }

  // Show up to N warnings
  for (const warn of warnings.slice(0, MAX_DIAGNOSTIC_WARNINGS)) {
    parts.push(`  WARN line ${String(warn.range.start.line + 1)}: ${warn.message}`);
  }
  if (warnings.length > MAX_DIAGNOSTIC_WARNINGS) {
    parts.push(`  ... and ${String(warnings.length - MAX_DIAGNOSTIC_WARNINGS)} more warning(s)`);
  }

  if (errors.length > 0) {
    parts.push("\n⚠️ Fix the errors above before proceeding.");
  }

  return parts.join("\n");
}
