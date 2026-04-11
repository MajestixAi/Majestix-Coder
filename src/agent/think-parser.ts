// ---------------------------------------------------------------------------
// <think> tag parser — isolated from all output/tool-execution logic
//
// Models like Qwen3.5 and Nemotron embed reasoning inside <think>...</think>
// blocks in their text stream. This module parses those tags across chunk
// boundaries and returns clearly-labelled segments so the caller can route
// thinking content to the display trace and real output to tool execution —
// with zero cross-contamination between the two paths.
// ---------------------------------------------------------------------------

export interface ThinkSegment {
  text: string;
  isThinking: boolean;
}

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/**
 * Parse accumulated streaming text for `<think>` / `</think>` tags.
 *
 * Returns a list of labelled segments plus a "remaining" buffer that holds
 * any partial tag boundary that can't be classified yet (emitted on the next
 * chunk). The caller must route `isThinking: true` segments exclusively to
 * the thinking display — they must never reach tool execution or currentText.
 *
 * @param buffer   - Accumulated text since last call (previous remaining + new chunk).
 * @param isInTag  - Whether we entered this call already inside a `<think>` block.
 * @returns Parsed output segments, any remaining partial-tag buffer, and updated in-tag state.
 */
export function processThinkBuffer(
  buffer: string,
  isInTag: boolean,
): { output: ThinkSegment[]; remaining: string; isInTag: boolean } {
  const output: ThinkSegment[] = [];
  let pos = 0;
  let inTag = isInTag;

  while (pos < buffer.length) {
    if (inTag) {
      const closeIdx = buffer.indexOf(CLOSE_TAG, pos);
      if (closeIdx === -1) {
        // No closing tag yet — hold back the last N chars in case the tag
        // spans this chunk boundary (N = length of "</think>").
        const safeEnd = Math.max(pos, buffer.length - CLOSE_TAG.length);
        if (safeEnd > pos) {
          output.push({ text: buffer.slice(pos, safeEnd), isThinking: true });
        }
        return { output, remaining: buffer.slice(safeEnd), isInTag: true };
      }
      if (closeIdx > pos) {
        output.push({ text: buffer.slice(pos, closeIdx), isThinking: true });
      }
      pos = closeIdx + CLOSE_TAG.length;
      inTag = false;
    } else {
      const openIdx = buffer.indexOf(OPEN_TAG, pos);
      if (openIdx === -1) {
        // No opening tag — hold back last N chars for boundary safety.
        const safeEnd = Math.max(pos, buffer.length - OPEN_TAG.length);
        if (safeEnd > pos) {
          output.push({ text: buffer.slice(pos, safeEnd), isThinking: false });
        }
        return { output, remaining: buffer.slice(safeEnd), isInTag: false };
      }
      if (openIdx > pos) {
        output.push({ text: buffer.slice(pos, openIdx), isThinking: false });
      }
      pos = openIdx + OPEN_TAG.length;
      inTag = true;
    }
  }

  return { output, remaining: "", isInTag: inTag };
}
