import { Marked } from "marked";
import hljs from "highlight.js/lib/core";

// Register only common languages to keep bundle small
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import php from "highlight.js/lib/languages/php";
import ruby from "highlight.js/lib/languages/ruby";
import swift from "highlight.js/lib/languages/swift";
import kotlin from "highlight.js/lib/languages/kotlin";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("java", java);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("c", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("cs", csharp);
hljs.registerLanguage("php", php);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rb", ruby);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("kt", kotlin);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("docker", dockerfile);

// Custom renderer: wraps code blocks in a header+wrapper for language labels
// and copy button injection in ChatMessage.tsx.
const codeRenderer = {
  code({ text, lang }: { text: string; lang?: string; escaped?: boolean }): string {
    const language = (lang ?? "").toLowerCase();
    let highlighted: string;
    if (language.length > 0 && hljs.getLanguage(language) !== undefined) {
      try {
        highlighted = hljs.highlight(text, { language }).value;
      } catch {
        highlighted = hljs.highlightAuto(text).value;
      }
    } else {
      highlighted = hljs.highlightAuto(text).value;
    }
    const langLabel = language.length > 0
      ? "<span class=\"code-block-lang\">" + language + "</span>"
      : "<span class=\"code-block-lang\"></span>";
    return (
      "<div class=\"code-block-wrapper\">" +
      "<div class=\"code-block-header\">" + langLabel + "</div>" +
      "<pre><code class=\"hljs" + (language.length > 0 ? " language-" + language : "") + "\">" + highlighted + "</code></pre>" +
      "</div>"
    );
  },
};

const marked = new Marked({ renderer: codeRenderer });

marked.setOptions({
  gfm: true,
  breaks: true,
});

// ---------------------------------------------------------------------------
// Table normalization — ported from web app MarkdownRenderer.tsx
// Fixes common LLM output issues: malformed separators, glued headers,
// space-aligned tables, and collapsed rows.
// ---------------------------------------------------------------------------

const TABLE_ROW_RE = /^\|.+\|/m;

/**
 * Fix malformed GFM tables in 4 passes.
 *
 * @param md - The markdown string to fix tables in.
 * @returns The markdown string with normalized GFM table formatting.
 */
function fixTables(md: string): string {
  let result = md;

  // Pass 0: Split rows glued together as || (no newline between rows).
  // Models sometimes emit: |sep|sep|sep|| data|data|data|| data|data|data|
  // Also catches cases where a table header is glued to preceding text, e.g.:
  //   "## Heading| col1 | col2 || --- | --- |"
  // In that case the line doesn't start with |, so we must still split the ||.
  // Only split || that are preceded by actual cell content (|text||) to avoid
  // incorrectly splitting boolean-OR expressions in code.
  result = result.split("\n").map(line => {
    if (!line.includes("||")) { return line; }
    return line.replace(/(\|[^|]+)\|\|/g, "$1|\n|");
  }).join("\n");

  // Pass 1: Detach table headers glued to preceding text
  result = detachInlineTableHeaders(result);

  // Pass 2: Convert tab/space-aligned tables to GFM
  result = convertSpaceAlignedTables(result);

  // Pass 3: Split collapsed rows
  result = splitCollapsedTableRows(result);

  // Pass 4: Fix malformed separator dashes (< 3 dashes)
  const SEP_LINE_RE = /^(\|[\s:-]*)+\|?\s*$/;
  const lines = result.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("|") || !SEP_LINE_RE.test(line)) {continue;}
    const prevLine = lines[i - 1];
    if (!TABLE_ROW_RE.test(prevLine)) {continue;}

    const parts = line.split("|");
    let changed = false;
    for (let j = 0; j < parts.length; j++) {
      const cell = parts[j].trim();
      if (cell === "") {continue;}
      const dashCount = (cell.match(/-/g) ?? []).length;
      if (dashCount < 3) {
        const leftColon = cell.startsWith(":");
        const rightColon = cell.endsWith(":");
        const pad = leftColon && rightColon ? ":---:" : leftColon ? ":---" : rightColon ? "---:" : "---";
        parts[j] = ` ${pad} `;
        changed = true;
      }
    }
    if (changed) {
      lines[i] = parts.join("|");
    }
  }
  return lines.join("\n");
}

/**
 * Detach table headers that are glued to preceding text on the same line.
 *
 * @param md - The markdown string to process.
 * @returns The markdown string with table headers separated from preceding text.
 */
function detachInlineTableHeaders(md: string): string {
  const lines = md.split("\n");
  const output: string[] = [];

  for (const line of lines) {
    if (!line.includes("|") || line.trimStart().startsWith("|")) {
      output.push(line);
      continue;
    }

    const tableStartMatch = /^(.+?)\s*(\|(?:[^|]+\|){2,}\s*)$/.exec(line);
    if (tableStartMatch !== null) {
      const prefix = tableStartMatch[1].trim();
      const tableRow = tableStartMatch[2].trim();
      const cells = tableRow.split("|").filter(c => c.trim() !== "");
      if (cells.length >= 2 && cells.some(c => /\w/.test(c))) {
        if (prefix.length > 0) {output.push(prefix);}
        output.push(tableRow);
        continue;
      }
    }

    output.push(line);
  }

  return output.join("\n");
}

/**
 * Convert tab/space-aligned tables to GFM pipe tables.
 *
 * @param md - The markdown string to convert.
 * @returns The markdown string with space-aligned tables converted to GFM pipe format.
 */
function convertSpaceAlignedTables(md: string): string {
  const lines = md.split("\n");
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim() || line.includes("|") || line.startsWith("#") || line.startsWith("```") || line.startsWith("- ") || line.startsWith("* ")) {
      output.push(line);
      i++;
      continue;
    }

    const cols = splitByAlignment(line);
    if (cols.length < 3) {
      output.push(line);
      i++;
      continue;
    }

    const numCols = cols.length;
    const tableLines: string[][] = [cols];
    let j = i + 1;

    while (j < lines.length) {
      const nextLine = lines[j];
      if (!nextLine.trim()) {break;}
      if (nextLine.includes("|")) {break;}
      if (nextLine.startsWith("#") || nextLine.startsWith("```")) {break;}
      const nextCols = splitByAlignment(nextLine);
      if (nextCols.length < numCols - 1 || nextCols.length > numCols + 1) {break;}
      while (nextCols.length < numCols) {nextCols.push("");}
      if (nextCols.length > numCols) {nextCols.length = numCols;}
      tableLines.push(nextCols);
      j++;
    }

    if (tableLines.length >= 2) {
      for (let row = 0; row < tableLines.length; row++) {
        const rowData = tableLines[row];
        output.push("| " + rowData.join(" | ") + " |");
        if (row === 0) {
          output.push("| " + tableLines[0].map(() => "---").join(" | ") + " |");
        }
      }
      i = j;
    } else {
      output.push(line);
      i++;
    }
  }

  return output.join("\n");
}

/**
 * Split a line by tab or multi-space alignment into columns.
 *
 * @param line - A line of text to split into columns.
 * @returns An array of column strings, or an empty array if fewer than 3 columns detected.
 */
function splitByAlignment(line: string): string[] {
  const trimmed = line.trim();
  if (trimmed.includes("\t")) {
    const parts = trimmed.split(/\t+/).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 3) {return parts;}
  }
  const parts = trimmed.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 3) {return parts;}
  return [];
}

/**
 * Split table rows that the model collapsed onto a single line.
 *
 * @param md - The markdown string to process for collapsed table rows.
 * @returns The markdown string with any collapsed table rows expanded to separate lines.
 */
function splitCollapsedTableRows(md: string): string {
  const lines = md.split("\n");
  const output: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.trimStart().startsWith("|") || !line.trimEnd().endsWith("|")) {
      output.push(line);
      continue;
    }

    const expectedCols = getExpectedColumns(lines, i);
    if (expectedCols <= 0) {
      output.push(line);
      continue;
    }

    const cells = line.split("|").filter(c => c.trim() !== "");
    if (cells.length <= expectedCols) {
      output.push(line);
      continue;
    }

    for (let start = 0; start < cells.length; start += expectedCols) {
      const rowCells = cells.slice(start, start + expectedCols);
      if (rowCells.length > 0) {
        output.push("| " + rowCells.map(c => c.trim()).join(" | ") + " |");
      }
    }
  }

  return output.join("\n");
}

/**
 * Find expected column count from the nearest separator row.
 *
 * @param lines - The full array of markdown lines to search within.
 * @param currentIdx - The index of the current line being evaluated.
 * @returns The number of expected columns based on the nearest separator row, or -1 if not found.
 */
function getExpectedColumns(lines: string[], currentIdx: number): number {
  const SEP_CELL = /^\s*:?-{3,}:?\s*$/;
  for (let offset = -5; offset <= 5; offset++) {
    const idx = currentIdx + offset;
    if (idx < 0 || idx >= lines.length || idx === currentIdx) {continue;}
    const line = lines[idx];
    if (!line.includes("|") || !line.includes("-")) {continue;}
    const cells = line.split("|").filter(c => c.trim() !== "");
    if (cells.length >= 2 && cells.every(c => SEP_CELL.test(c))) {
      return cells.length;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Renders a markdown string to HTML with syntax highlighting and table normalization.
 *
 * @param text - The raw markdown text to render.
 * @returns An HTML string ready to inject into the webview.
 */
export function renderMarkdown(text: string): string {
  if (text.length === 0) {return "";}

  // Normalize escaped newlines from SSE streaming
  let src = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  src = src.replace(/\r\n?/g, "\n");

  // Ensure a blank line before every code fence.
  // Models like Qwen often emit "...prose:```tsx\ncode" with no preceding blank
  // line, which marked does not recognize as a code block (outputs raw backticks).
  src = src.replace(/([^\n])(`{3,})/g, "$1\n\n$2");
  src = src.replace(/([^\n])\n(`{3,})/g, "$1\n\n$2");

  // Fix malformed tables before parsing
  src = fixTables(src);

  return marked.parse(src) as string;
}
