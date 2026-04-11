/**
 * Tracks consecutive tool failures per-file and globally.
 *
 * Inspired by Kilo Code's error escalation system: after repeated failures on
 * the same file, the tracker injects escalation context into tool results so
 * the LLM gets a stronger signal to change approach (re-read the file, use a
 * different strategy, or ask the user for help).
 */

/** Threshold: after this many consecutive failures on one file, escalate. */
const PER_FILE_ESCALATION_THRESHOLD = 2;

/** Threshold: after this many consecutive global failures, hard-stop the loop. */
const GLOBAL_FAILURE_LIMIT = 3;

/**
 * Tracks consecutive tool failures per-file and globally, providing escalation
 * messages when the agent is spiraling.
 */
export class ErrorTracker {
  /** Per-file consecutive failure counts for edit_file calls. */
  private _editFileErrors = new Map<string, number>();

  /** Per-file consecutive failure counts for write_to_file calls. */
  private _writeFileErrors = new Map<string, number>();

  /** Global consecutive mistake count (any tool). */
  private _consecutiveMistakes = 0;

  /** Whether any tool failed in the current iteration (reset per-iteration). */
  private _failedThisTurn = false;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Whether the global failure limit has been reached (caller should stop the loop).
   *
   * @returns True if the limit is reached.
   */
  get shouldStop(): boolean {
    return this._consecutiveMistakes >= GLOBAL_FAILURE_LIMIT;
  }

  /**
   * Whether any tool failed in the current turn.
   *
   * @returns True if a failure occurred this turn.
   */
  get failedThisTurn(): boolean {
    return this._failedThisTurn;
  }

  /**
   * Current consecutive global mistake count.
   *
   * @returns The count of consecutive mistakes.
   */
  get consecutiveMistakes(): number {
    return this._consecutiveMistakes;
  }

  /**
   * Record a successful tool execution.
   * Resets the global counter and any per-file counter for the given file.
   *
   * @param toolName - The name of the tool that succeeded.
   * @param filePath - Optional file path associated with the tool call.
   */
  recordSuccess(toolName: string, filePath?: string): void {
    this._consecutiveMistakes = 0;
    this._failedThisTurn = false;

    if (filePath !== undefined) {
      if (toolName === "edit_file") {
        this._editFileErrors.delete(filePath);
      } else if (toolName === "write_to_file") {
        this._writeFileErrors.delete(filePath);
      }
    }
  }

  /**
   * Record a tool failure. Returns an optional escalation message to append
   * to the tool_result error so the LLM gets stronger guidance.
   *
   * @param toolName - The name of the tool that failed.
   * @param filePath - Optional file path associated with the tool call.
   * @returns An escalation message string, or null if no escalation is needed.
   */
  recordFailure(toolName: string, filePath?: string): string | null {
    this._consecutiveMistakes++;
    this._failedThisTurn = true;

    if (filePath === undefined) {
      return this._globalEscalation();
    }

    const map = toolName === "edit_file"
      ? this._editFileErrors
      : toolName === "write_to_file"
        ? this._writeFileErrors
        : null;

    if (map !== null) {
      const count = (map.get(filePath) ?? 0) + 1;
      map.set(filePath, count);

      if (count >= PER_FILE_ESCALATION_THRESHOLD) {
        return this._fileEscalation(toolName, filePath, count);
      }
    }

    return this._globalEscalation();
  }

  /** Reset the per-turn failure flag (call at the start of each iteration). */
  resetTurn(): void {
    this._failedThisTurn = false;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Build an escalation message for repeated failures on a specific file.
   *
   * @param toolName - The tool that has been failing.
   * @param filePath - The file path that has been failing.
   * @param count - The number of consecutive failures on this file.
   * @returns An escalation message string.
   */
  private _fileEscalation(toolName: string, filePath: string, count: number): string {
    const action = toolName === "edit_file" ? "editing" : "writing to";
    return (
      `\n\n⚠️ You have failed ${String(count)} consecutive times ${action} "${filePath}". ` +
      "STOP and read the file first with read_file to see its current content, " +
      "then retry with the exact text from the file. " +
      "If the file has changed since you last read it, your old_text will not match."
    );
  }

  /**
   * Build an escalation message based on global consecutive failure count.
   *
   * @returns An escalation message string, or null if the count is too low.
   */
  private _globalEscalation(): string | null {
    if (this._consecutiveMistakes >= GLOBAL_FAILURE_LIMIT - 1) {
      return (
        `\n\n⚠️ ${String(this._consecutiveMistakes)} consecutive tool failures. ` +
        "You are about to be stopped. Re-read the relevant files and take a completely different approach."
      );
    }
    if (this._consecutiveMistakes >= 3) {
      return (
        `\n\n⚠️ ${String(this._consecutiveMistakes)} consecutive failures. ` +
        "Consider re-reading the file with read_file before retrying."
      );
    }
    return null;
  }
}
