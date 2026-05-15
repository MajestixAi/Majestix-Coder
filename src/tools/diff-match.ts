/**
 * Fuzzy diff matching engine for edit_file operations.
 *
 * Provides Levenshtein-based similarity matching, middle-out search,
 * indentation-aware replacement, and line ending preservation.
 * Inspired by Kilo Code's MultiSearchReplaceDiffStrategy.
 */

// ---------------------------------------------------------------------------
// Line ending detection / preservation
// ---------------------------------------------------------------------------

export type LineEnding = "\n" | "\r\n";

/**
 * Detect the dominant line ending in a file.
 *
 * @param text - The file content to analyze.
 * @returns The detected line ending style.
 */
export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Normalize all line endings to LF for matching.
 *
 * @param text - The text to normalize.
 * @returns The text with all line endings converted to LF.
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Restore the original line ending style after replacement.
 *
 * @param text - The text to restore line endings in.
 * @param ending - The target line ending style.
 * @returns The text with the specified line ending style.
 */
export function restoreLineEndings(text: string, ending: LineEnding): string {
  if (ending === "\r\n") {
    // First normalize to LF, then convert to CRLF
    return text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  }
  return text;
}

// ---------------------------------------------------------------------------
// Levenshtein similarity
// ---------------------------------------------------------------------------

/**
 * Compute normalized Levenshtein similarity between two strings (0..1).
 * 1.0 = identical, 0.0 = completely different.
 * Uses an optimized single-row DP approach for memory efficiency.
 *
 * @param a - First string to compare.
 * @param b - Second string to compare.
 * @returns A similarity score between 0.0 and 1.0.
 */
export function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) { return 1.0; }
  if (a.length === 0 || b.length === 0) { return 0.0; }

  const maxLen = Math.max(a.length, b.length);

  // For very long strings, use a line-based comparison instead
  if (maxLen > 10_000) {
    return lineSimilarity(a, b);
  }

  // Single-row DP
  const bLen = b.length;
  const row = new Uint32Array(bLen + 1);
  for (let j = 0; j <= bLen; j++) { row[j] = j; }

  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(
        row[j] + 1,       // deletion
        row[j - 1] + 1,   // insertion
        prev + cost        // substitution
      );
      prev = row[j];
      row[j] = val;
    }
  }

  return 1 - row[bLen] / maxLen;
}

/**
 * Fast line-based similarity for large texts.
 *
 * @param a - First text to compare.
 * @param b - Second text to compare.
 * @returns A similarity score between 0.0 and 1.0.
 */
function lineSimilarity(a: string, b: string): number {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const maxLines = Math.max(aLines.length, bLines.length);
  if (maxLines === 0) { return 1.0; }

  let matches = 0;
  const bSet = new Set(bLines);
  for (const line of aLines) {
    if (bSet.has(line)) { matches++; }
  }
  return matches / maxLines;
}

// ---------------------------------------------------------------------------
// Indentation-aware replacement
// ---------------------------------------------------------------------------

/**
 * Apply a replacement while preserving the indentation context of the matched text.
 * If the matched text has a different base indent than the replacement template,
 * adjust the replacement to match.
 *
 * @param matchedText - The original text that was matched in the file.
 * @param replacementText - The replacement text to adjust indentation for.
 * @returns The replacement text with adjusted indentation.
 */
export function indentAwareReplace(
  matchedText: string,
  replacementText: string
): string {
  const matchedLines = matchedText.split("\n");
  const replaceLines = replacementText.split("\n");

  if (matchedLines.length === 0 || replaceLines.length === 0) {
    return replacementText;
  }

  // Detect base indentation of matched text (first non-empty line)
  const matchIndent = getBaseIndent(matchedLines);
  const replaceIndent = getBaseIndent(replaceLines);

  // If indentation is the same, no adjustment needed
  if (matchIndent === replaceIndent) {
    return replacementText;
  }

  // Calculate the indent delta and apply to replacement
  const matchIndentLen = matchIndent.length;
  const replaceIndentLen = replaceIndent.length;

  return replaceLines.map((line, i) => {
    if (i === 0 || line.trim().length === 0) { return line; }

    const currentIndent = /^(\s*)/.exec(line)?.[1] ?? "";
    const relativeIndent = currentIndent.length - replaceIndentLen;
    const newIndentLen = Math.max(0, matchIndentLen + relativeIndent);

    // Use the same indent character (tab vs space) as the matched text
    const indentChar = matchIndent.includes("\t") ? "\t" : " ";
    return indentChar.repeat(newIndentLen) + line.trimStart();
  }).join("\n");
}

/**
 * Extract the base indentation from a set of lines (first non-empty line).
 *
 * @param lines - Array of lines to inspect.
 * @returns The indentation string of the first non-empty line.
 */
function getBaseIndent(lines: string[]): string {
  for (const line of lines) {
    if (line.trim().length > 0) {
      return /^(\s*)/.exec(line)?.[1] ?? "";
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Strip line-number prefixes
// ---------------------------------------------------------------------------

/**
 * Strip line-number prefixes that read_file adds (e.g. "   42 | code...").
 * LLMs often copy these into old_text, causing exact match to fail.
 *
 * @param text - The text that may contain line-number prefixes.
 * @returns The text with line-number prefixes removed.
 */
export function stripLineNumberPrefixes(text: string): string {
  return text.replace(/^\s*\d+\s*\|\s?/gm, "");
}

// ---------------------------------------------------------------------------
// Middle-out fuzzy search
// ---------------------------------------------------------------------------

/** Result of a fuzzy search operation. */
export interface FuzzyMatch {
  index: number;
  similarity: number;
  matchedText: string;
}

/** Maximum characters allowed in needle for fuzzy search. */
const FUZZY_MAX_CHARS = 2_000;

/** Maximum lines allowed in needle for fuzzy search. */
const FUZZY_MAX_LINES = 50;

/** Maximum search radius (lines) for middle-out expansion. */
const FUZZY_MAX_RADIUS = 20;

/**
 * Search for `needle` in `haystack` using fuzzy matching.
 * Starts from a hint position (or middle) and expands outward.
 *
 * @param haystack - The full file content to search in.
 * @param needle - The text to search for.
 * @param threshold - Minimum similarity to accept (0.0-1.0, default 0.8).
 * @param hintLine - Optional line number hint for where to start searching.
 * @returns The best match found, or null if none meets the threshold.
 */
export function fuzzySearch(
  haystack: string,
  needle: string,
  threshold = 0.8,
  hintLine?: number
): FuzzyMatch | null {
  const haystackLines = haystack.split("\n");
  const needleLines = needle.split("\n");
  const needleLineCount = needleLines.length;

  if (needleLineCount === 0 || haystackLines.length === 0) {
    return null;
  }

  // Guard: reject needles that are too long for efficient fuzzy matching
  if (needle.length > FUZZY_MAX_CHARS) {
    return null;
  }

  // Guard: reject needles with too many lines
  if (needleLineCount > FUZZY_MAX_LINES) {
    return null;
  }

  // Determine starting position
  const startLine = hintLine !== undefined
    ? Math.min(Math.max(0, hintLine - 1), haystackLines.length - 1)
    : Math.floor(haystackLines.length / 2);

  let bestMatch: FuzzyMatch | null = null;
  let bestSimilarity = threshold;

  // Middle-out search: check startLine first, then expand outward
  const maxRadius = Math.min(
    FUZZY_MAX_RADIUS,
    Math.max(startLine, haystackLines.length - startLine)
  );

  for (let radius = 0; radius <= maxRadius; radius++) {
    const positions = radius === 0
      ? [startLine]
      : [startLine - radius, startLine + radius].filter(
        p => p >= 0 && p + needleLineCount <= haystackLines.length
      );

    for (const pos of positions) {
      if (pos < 0 || pos + needleLineCount > haystackLines.length) { continue; }

      const candidate = haystackLines.slice(pos, pos + needleLineCount).join("\n");
      const similarity = levenshteinSimilarity(needle, candidate);

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = {
          index: haystackLines.slice(0, pos).join("\n").length + (pos > 0 ? 1 : 0),
          similarity,
          matchedText: candidate,
        };

        // Perfect match — stop searching
        if (similarity >= 0.99) { return bestMatch; }
      }
    }

    // Early exit: if we've searched enough and found a good match
    if (radius >= FUZZY_MAX_RADIUS - 1 && bestMatch !== null && bestMatch.similarity > 0.9) {
      break;
    }
  }

  return bestMatch;
}

// ---------------------------------------------------------------------------
// Safe dollar-sign escaping for string replacement
// ---------------------------------------------------------------------------

/**
 * Escape `$` characters in a replacement string to prevent JS regex
 * substitution patterns ($1, $&, etc.) from corrupting the output.
 *
 * @param text - The text to escape dollar signs in.
 * @returns The text with dollar signs escaped.
 */
export function escapeDollarSigns(text: string): string {
  return text.replace(/\$/g, "$$$$");
}

// ---------------------------------------------------------------------------
// Find nearby context (for error messages)
// ---------------------------------------------------------------------------

/**
 * Find the best matching location in the file for a search string.
 * Returns context lines around the expected area to help the LLM self-correct.
 *
 * @param content - The full file content to search in.
 * @param searchText - The text to search for.
 * @param maxLines - Maximum number of context lines to include.
 * @returns A string with nearby context, or empty string if none found.
 */
export function findNearbyContext(content: string, searchText: string, maxLines = 5): string {
  const searchLines = searchText.split("\n").filter(l => l.trim());
  if (searchLines.length === 0) { return ""; }

  const firstLine = searchLines[0].trim();
  if (firstLine.length < 4) { return ""; }

  const contentLines = content.split("\n");
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].includes(firstLine)) {
      const start = Math.max(0, i - 1);
      const end = Math.min(contentLines.length, i + maxLines);
      const snippet = contentLines.slice(start, end)
        .map((l, idx) => `${String(start + idx + 1).padStart(5)} | ${l}`)
        .join("\n");
      return `\nNearest match found around line ${String(i + 1)}:\n${snippet}`;
    }
  }
  return "";
}
