import * as vscode from "vscode";
import type { ToolHandler, ToolResult, ToolContext } from "./types";

const MAX_RESULTS = 100;
const MAX_FILE_SIZE = 500_000;

export const searchFilesTool: ToolHandler = {
  definition: {
    name: "search_files",
    description:
      "Search for a regex pattern across files in the workspace. " +
      "Returns matching lines with file paths and line numbers. " +
      "Use the include glob to filter file types (e.g. '*.ts').",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern to search for",
        },
        path: {
          type: "string",
          description:
            "Directory to search in (relative to workspace root). Defaults to root.",
        },
        include: {
          type: "string",
          description: "Glob pattern to filter files (e.g. '*.ts', '**/*.py')",
        },
      },
      required: ["pattern"],
    },
  },

  requiresApproval: () => false,

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const patternStr = input.pattern as string;
    const searchPath = (input.path as string | undefined) ?? "";
    const includeGlob = (input.include as string | undefined) ?? "**/*";

    // Detect glob patterns passed in the wrong field (e.g. "**/*.ts" or "/src/**/*.ts")
    if (isGlobPattern(patternStr)) {
      return {
        tool_use_id: "",
        content: `"${patternStr}" looks like a glob pattern, not a regex. Use the "include" parameter to filter files by name (e.g. include: "**/*.ts"), and "pattern" for the regex content to search for within those files.`,
        is_error: true,
      };
    }

    const redosWarning = detectReDoS(patternStr);
    if (redosWarning !== null) {
      return {
        tool_use_id: "",
        content: `Regex pattern rejected: ${redosWarning}. Simplify the pattern to avoid catastrophic backtracking.`,
        is_error: true,
      };
    }

    let regex: RegExp;
    try {
      regex = new RegExp(patternStr, "gi");
    } catch (e: unknown) {
      return {
        tool_use_id: "",
        content: `Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
      };
    }

    const baseUri = searchPath.length > 0
      ? vscode.Uri.joinPath(context.workspaceRoot, searchPath)
      : context.workspaceRoot;

    // Use VS Code's findFiles to get matching files
    const relativePattern = new vscode.RelativePattern(baseUri, includeGlob);
    const files = await vscode.workspace.findFiles(
      relativePattern,
      "**/node_modules/**",
      1000
    );

    const results: string[] = [];
    let totalMatches = 0;

    for (const fileUri of files) {
      if (totalMatches >= MAX_RESULTS) {break;}

      try {
        const stat = await vscode.workspace.fs.stat(fileUri);
        if (stat.size > MAX_FILE_SIZE) {continue;}

        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const text = new TextDecoder().decode(bytes);
        const lines = text.split("\n");
        const relPath = vscode.workspace.asRelativePath(fileUri);

        for (let i = 0; i < lines.length; i++) {
          if (totalMatches >= MAX_RESULTS) {break;}
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            results.push(`${relPath}:${String(i + 1)}: ${lines[i].trimEnd()}`);
            totalMatches++;
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    if (results.length === 0) {
      return {
        tool_use_id: "",
        content: `No matches found for pattern: ${patternStr}`,
      };
    }

    const truncated =
      totalMatches >= MAX_RESULTS
        ? `\n(showing first ${String(MAX_RESULTS)} matches)`
        : "";
    return {
      tool_use_id: "",
      content: `Found ${String(totalMatches)} match(es):\n${results.join("\n")}${truncated}`,
    };
  },
};

/**
 * Returns true if the string looks like a file-glob pattern rather than a regex.
 * Common indicators: starts with `*` or `/`, contains `**`, or matches `*.ext` form.
 *
 * @param s - The pattern string to inspect.
 * @returns True if the pattern looks like a glob, false if it looks like a regex.
 */
function isGlobPattern(s: string): boolean {
  return (
    s.startsWith("*") ||
    s.startsWith("/") ||
    s.includes("**") ||
    /^\*\.[a-z0-9]+$/i.test(s)  // e.g. "*.ts"
  );
}

/**
 * Heuristic check for regex patterns that can cause catastrophic backtracking (ReDoS).
 * Detects nested quantifiers such as (x+)+, (x*)*, (.+)+, (x+)*, etc.
 *
 * @param pattern - The raw regex pattern string to inspect.
 * @returns A human-readable reason string if the pattern is dangerous, or null if it looks safe.
 */
function detectReDoS(pattern: string): string | null {
  // Nested quantifiers: a group followed by a quantifier, where the group itself contains a quantifier
  // Covers: (a+)+  (a*)* (.+)+ ([a-z]+)* etc.
  if (/\([^)]*[+*][^)]*\)[+*?]/.test(pattern)) {
    return "pattern contains nested quantifiers (e.g. (a+)+ or (a*)*)";
  }
  // Alternation with overlap inside a repeated group: (a|a)+
  if (/\([^)]*\|[^)]*\)[+*]/.test(pattern)) {
    return "pattern contains alternation inside a repeated group (e.g. (a|a)+)";
  }
  return null;
}
