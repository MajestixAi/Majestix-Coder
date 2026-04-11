import { spawn } from "child_process";
import * as path from "path";
import * as vscode from "vscode";

import { resolveWorkspacePath } from "../util/path-safety";
import { trackEvent } from "../util/telemetry";
import type {
  ToolContext,
  ToolHandler,
  ToolResult,
} from "./types";

const MAX_OUTPUT = 10_000;

// ---------------------------------------------------------------------------
// Hot-process detection — compilation-like processes get extended timeouts
// ---------------------------------------------------------------------------

const HOT_PATTERNS = /compiling|building|bundling|transpiling|linking|downloading|installing|resolving|fetching/i;

// ---------------------------------------------------------------------------
// Circuit-breaker — prevents rapid-fire retries of failing commands
// ---------------------------------------------------------------------------

/** Maximum consecutive command failures before the breaker trips. */
const BREAKER_FAILURE_THRESHOLD = 3;

/** Backoff durations (ms) for each consecutive failure: 1s → 2s → 4s. */
const BACKOFF_SCHEDULE_MS = [1_000, 2_000, 4_000];

/** Cooldown period (ms) after the breaker trips — no commands for 30 s. */
const BREAKER_COOLDOWN_MS = 30_000;

/** Window (ms) in which failures count toward the breaker — resets if no failure for 5 min. */
const FAILURE_WINDOW_MS = 5 * 60 * 1_000;

interface CommandFailure {
  timestamp: number;
  command: string;
}

const circuitBreaker = {
  failures: [] as CommandFailure[],
  trippedAt: 0,

  /** Prune failures older than the sliding window. */
  prune(): void {
    const cutoff = Date.now() - FAILURE_WINDOW_MS;
    this.failures = this.failures.filter((f) => f.timestamp > cutoff);
  },

  /**
   * Record a failure. Returns the backoff delay (ms) to apply, or -1 if tripped.
   *
   * @param command - The command string that failed.
   * @returns The backoff delay in ms, or -1 if the breaker tripped.
   */
  recordFailure(command: string): number {
    this.prune();
    this.failures.push({ timestamp: Date.now(), command });

    if (this.failures.length >= BREAKER_FAILURE_THRESHOLD) {
      this.trippedAt = Date.now();
      trackEvent("command.breaker.tripped", {
        consecutiveFailures: this.failures.length,
        lastCommand: command.slice(0, 100),
      });
      return -1; // breaker tripped
    }

    const idx = Math.min(this.failures.length - 1, BACKOFF_SCHEDULE_MS.length - 1);
    return BACKOFF_SCHEDULE_MS[idx];
  },

  /**
   * Record a success — resets the failure window.
   *
   * @returns void
   */
  recordSuccess(): void {
    this.failures = [];
    this.trippedAt = 0;
  },

  /**
   * Check if the breaker is currently tripped (in cooldown).
   *
   * @returns True if the breaker is tripped and in cooldown.
   */
  isTripped(): boolean {
    if (this.trippedAt === 0) { return false; }
    if (Date.now() - this.trippedAt > BREAKER_COOLDOWN_MS) {
      // Cooldown expired — reset
      this.failures = [];
      this.trippedAt = 0;
      return false;
    }
    return true;
  },

  /**
   * Seconds remaining in cooldown, or 0 if not tripped.
   *
   * @returns The number of seconds remaining in cooldown.
   */
  cooldownRemaining(): number {
    if (!this.isTripped()) { return 0; }
    return Math.ceil((BREAKER_COOLDOWN_MS - (Date.now() - this.trippedAt)) / 1000);
  },
};

// ---------------------------------------------------------------------------
// Dangerous command detection (expanded)
// ---------------------------------------------------------------------------

// Patterns that are NEVER legitimate in an agentic coding context.
// Destructive file operations (rm, chmod, chown) are NOT blocked here —
// they're path-gated below to ensure they stay inside the workspace.
const CRITICAL_BLOCK_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "fork_bomb", pattern: /:\(\)\{\s*:\|:\s*&\s*\};:/ },
  { label: "filesystem_format", pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/i },
  { label: "system_shutdown", pattern: /\b(?:poweroff|reboot|shutdown)\b/i },
  {
    label: "raw_disk_write",
    pattern: /\bdd\b[^\n]*\bof\s*=\s*\/dev\/(?:sd[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|disk\d+s\d+)/i,
  },
  { label: "curl_pipe_to_shell", pattern: /\bcurl\b[^\n]*\|\s*(?:ba?sh|sh|zsh)\b/i },
  { label: "wget_pipe_to_shell", pattern: /\bwget\b[^\n]*-O\s*-[^\n]*\|\s*(?:ba?sh|sh|zsh)\b/i },
  { label: "python_exec_pipe", pattern: /\bcurl\b[^\n]*\|\s*python/i },
  { label: "iptables_flush", pattern: /\biptables\s+-F\b/i },
];

// ---------------------------------------------------------------------------
// Workspace path gating — destructive commands must target the workspace
// ---------------------------------------------------------------------------

// Commands that modify/delete files — their path arguments must resolve inside cwd.
const PATH_GATED_COMMANDS = /\b(?:rm|rmdir|chmod|chown|mv)\b/;

/**
 * Extracts path-like arguments from a command string (after flags).
 * Returns tokens that look like file/directory paths, skipping flags.
 *
 * @param command - The shell command string.
 * @returns Array of path-like tokens from the command.
 */
function extractPathArgs(command: string): string[] {
  // Split on pipes/semicolons — only check the first command in a chain
  const firstCmd = command.split(/[|;&]/)[0];
  const tokens = firstCmd.trim().split(/\s+/);
  const paths: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    // Skip flags (anything starting with -)
    if (t.startsWith("-")) { continue; }
    // Skip common non-path args
    if (/^\d+$/.test(t)) { continue; }
    paths.push(t);
  }
  return paths;
}

/**
 * Checks that all path arguments in a destructive command resolve inside
 * the given cwd (workspace root). Returns an error string if any path
 * escapes, or null if all paths are safe.
 *
 * @param command - The shell command string to validate.
 * @param cwd - The working directory (workspace root) that paths must stay within.
 * @returns Error message if a path escapes the workspace, or null if safe.
 */
function checkPathEscapes(command: string, cwd: string): string | null {
  if (!PATH_GATED_COMMANDS.test(command)) { return null; }

  const pathArgs = extractPathArgs(command);
  for (const p of pathArgs) {
    const resolved = path.resolve(cwd, p);
    // Must be inside cwd — resolved path must start with cwd + separator (or equal cwd)
    if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
      return `Path "${p}" resolves to "${resolved}" which is outside the workspace (${cwd}). Destructive commands must target files within the workspace.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Output flood prevention — rewrite commands likely to produce massive output
// ---------------------------------------------------------------------------

/**
 * Rewrites commands that are likely to produce unbounded output by appending
 * limits. Does not block — just makes the command safer. Returns the original
 * command if no rewrite is needed.
 *
 * @param command - The shell command string to inspect and potentially rewrite.
 * @returns The (possibly rewritten) command string.
 */
function rewriteForOutputSafety(command: string): string {
  let cmd = command;

  // grep/rg without -l, -c, or head/tail pipe and without an explicit limit
  // → append | head -500 to cap line output
  if (/\b(?:grep|rg|ack|ag)\b/.test(cmd) &&
      !/\s-[lc]\b/.test(cmd) &&
      !/\|\s*(?:head|tail|wc)\b/.test(cmd) &&
      !cmd.includes("--max-count")) {
    cmd = cmd + " | head -500";
  }

  // find without -maxdepth or pipe → append | head -500
  if (/\bfind\b/.test(cmd) &&
      !cmd.includes("-maxdepth") &&
      !/\|\s*(?:head|tail|wc)\b/.test(cmd)) {
    cmd = cmd + " | head -500";
  }

  // cat/less/more of a file without head/tail → use head -1000
  if (/^\s*(?:cat|less|more)\s+/.test(cmd) &&
      !/\|\s*(?:head|tail|grep)\b/.test(cmd)) {
    cmd = cmd.replace(/^\s*(?:cat|less|more)\s+/, "head -1000 ");
  }

  return cmd;
}

// ---------------------------------------------------------------------------
// Command whitelist (optional — from settings)
// ---------------------------------------------------------------------------

/**
 * Reads the optional command whitelist from workspace settings.
 * When set and non-empty, only commands whose first token matches are allowed.
 *
 * @returns An array of allowed command prefixes, or empty if whitelist is disabled.
 */
function getCommandWhitelist(): string[] {
  return vscode.workspace
    .getConfiguration("majestix")
    .get<string[]>("commandWhitelist", []);
}

/**
 * Checks a command against the optional whitelist.
 *
 * @param command - The shell command string to validate.
 * @returns An error message if rejected, or null if allowed.
 */
function checkWhitelist(command: string): string | null {
  const whitelist = getCommandWhitelist();
  if (whitelist.length === 0) { return null; } // whitelist disabled

  // Extract the first token (the executable) from the command
  const trimmed = command.trim();
  const firstToken = trimmed.split(/\s+/)[0].replace(/^(?:sudo|env)\s+/, "");

  for (const allowed of whitelist) {
    if (firstToken === allowed || trimmed.startsWith(allowed)) {
      return null; // allowed
    }
  }

  return `Command "${firstToken}" is not in the allowed command list. Allowed: ${whitelist.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

/**
 * Reads the configured command timeout from workspace settings.
 *
 * @returns The timeout duration in milliseconds.
 */
function getTimeoutMs(): number {
  const seconds = vscode.workspace.getConfiguration("majestix").get<number>("commandTimeout", 10);
  return seconds * 1000;
}

/**
 * Checks whether terminal mirroring is enabled in workspace settings.
 *
 * @returns True if terminal mirroring is enabled.
 */
function isTerminalMirrorEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("majestix")
    .get<boolean>("terminalMirror", false);
}

// ---------------------------------------------------------------------------
// Terminal mirroring — optionally show output in a real VSCode terminal panel
// ---------------------------------------------------------------------------

let mirrorTerminal: vscode.Terminal | undefined;
const mirrorWriteEmitter = new vscode.EventEmitter<string>();

/**
 * Gets or creates the pseudoterminal used for output mirroring.
 *
 * @returns The VSCode terminal instance for mirroring command output.
 */
function getMirrorTerminal(): vscode.Terminal {
  if (mirrorTerminal !== undefined && mirrorTerminal.exitStatus === undefined) {
    return mirrorTerminal;
  }

  const pty: vscode.Pseudoterminal = {
    onDidWrite: mirrorWriteEmitter.event,
    open: () => {
      mirrorWriteEmitter.fire("Majestix AI — Command Output Mirror\r\n\r\n");
    },
    close: () => {
      mirrorTerminal = undefined;
    },
  };

  mirrorTerminal = vscode.window.createTerminal({
    name: "Majestix Command Mirror",
    pty,
  });
  return mirrorTerminal;
}

/**
 * Push text to the mirror terminal (converting LF to CRLF for terminal display).
 *
 * @param text - The text to display in the mirror terminal.
 */
function mirrorOutput(text: string): void {
  if (!isTerminalMirrorEnabled()) { return; }
  const terminal = getMirrorTerminal();
  terminal.show(true); // preserve focus
  mirrorWriteEmitter.fire(text.replace(/\n/g, "\r\n"));
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export const executeCommandTool: ToolHandler = {
  definition: {
    name: "execute_command",
    description:
      "Execute a shell command in the workspace. Returns stdout, stderr, and exit code. " +
      "Use this for running tests, installing dependencies, git operations, etc. " +
      "Commands run in the workspace root by default. " +
      "Run commands one at a time and wait for output before running the next. " +
      "Never use terminal commands to edit files — use edit_file or write_to_file instead.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        description: {
          type: "string",
          description: "Brief explanation of what this command does and why (shown to user in approval prompt)",
        },
        cwd: {
          type: "string",
          description:
            "Working directory relative to workspace root. Defaults to workspace root.",
        },
      },
      required: ["command"],
    },
  },

  requiresApproval: () => true,

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const command = input.command as string;
    const cwdRel = input.cwd as string | undefined;

    let cwd = context.workspaceRoot.fsPath;
    if (cwdRel !== undefined && cwdRel.length > 0) {
      try {
        cwd = resolveWorkspacePath(context.workspaceRoot, cwdRel).fsPath;
      } catch (e: unknown) {
        return {
          tool_use_id: "",
          content: `Invalid cwd: ${e instanceof Error ? e.message : String(e)}`,
          is_error: true,
        };
      }
    }

    // --- Safety: block dangerous commands ---
    const blocked = getBlockedCommand(command);
    if (blocked !== null) {
      trackEvent("command.blocked", { reason: blocked.label });
      return {
        tool_use_id: "",
        content: `Command blocked: ${blocked.label} — contains a critically dangerous operation`,
        is_error: true,
      };
    }

    // --- Safety: workspace path gate for destructive commands ---
    const pathError = checkPathEscapes(command, cwd);
    if (pathError !== null) {
      trackEvent("command.path_escape", { command: command.slice(0, 100) });
      return {
        tool_use_id: "",
        content: pathError,
        is_error: true,
      };
    }

    // --- Safety: check optional whitelist ---
    const whitelistError = checkWhitelist(command);
    if (whitelistError !== null) {
      trackEvent("command.whitelist.rejected", { command: command.slice(0, 100) });
      return {
        tool_use_id: "",
        content: whitelistError,
        is_error: true,
      };
    }

    // --- Circuit-breaker: check if tripped ---
    if (circuitBreaker.isTripped()) {
      const remaining = circuitBreaker.cooldownRemaining();
      trackEvent("command.breaker.blocked", { cooldownRemaining: remaining });
      return {
        tool_use_id: "",
        content:
          `Command execution paused: ${String(remaining)}s cooldown remaining after ${String(BREAKER_FAILURE_THRESHOLD)} consecutive failures. ` +
          "Wait for the cooldown to expire, or try a different approach.",
        is_error: true,
      };
    }

    // --- Circuit-breaker: apply backoff delay if recent failures ---
    const recentFailures = circuitBreaker.failures.length;
    if (recentFailures > 0) {
      const idx = Math.min(recentFailures - 1, BACKOFF_SCHEDULE_MS.length - 1);
      const delay = BACKOFF_SCHEDULE_MS[idx];
      trackEvent("command.backoff", { delayMs: delay, failures: recentFailures });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // --- Safety: rewrite commands likely to produce massive output ---
    const safeCommand = rewriteForOutputSafety(command);
    if (safeCommand !== command) {
      trackEvent("command.rewritten", { original: command.slice(0, 100), rewritten: safeCommand.slice(0, 100) });
    }

    // --- Execute ---
    const startTime = Date.now();
    try {
      mirrorOutput(`\x1b[36m$ ${safeCommand}\x1b[0m\n`);
      const result = await runCommandStreaming(safeCommand, cwd, context);
      const durationMs = Date.now() - startTime;

      // Parse exit code from result suffix
      const exitCodeMatch = /\[exit code: (\d+)\]/.exec(result);
      const exitCode = exitCodeMatch !== null ? parseInt(exitCodeMatch[1], 10) : 0;

      // Telemetry: structured command log
      trackEvent("command.executed", {
        command: command.slice(0, 200),
        cwd,
        durationMs,
        exitCode,
        outputBytes: result.length,
        timedOut: result.includes("[timed out"),
        blocked: false,
      });

      // Circuit-breaker: success resets failures
      if (exitCode === 0) {
        circuitBreaker.recordSuccess();
      } else {
        const backoff = circuitBreaker.recordFailure(command);
        if (backoff === -1) {
          // Breaker just tripped — append warning to result
          return {
            tool_use_id: "",
            content:
              result +
              `\n\n[circuit-breaker tripped: ${String(BREAKER_FAILURE_THRESHOLD)} consecutive failures — ` +
              `command execution paused for ${String(BREAKER_COOLDOWN_MS / 1000)}s. Try a different approach.]`,
            is_error: false,
          };
        }
      }

      return { tool_use_id: "", content: result };
    } catch (e: unknown) {
      const durationMs = Date.now() - startTime;
      const errMsg = e instanceof Error ? e.message : String(e);

      trackEvent("command.failed", {
        command: command.slice(0, 200),
        cwd,
        durationMs,
        error: errMsg.slice(0, 200),
      });

      circuitBreaker.recordFailure(command);

      return {
        tool_use_id: "",
        content: `Command failed: ${errMsg}`,
        is_error: true,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Streaming command execution using child_process.spawn
// ---------------------------------------------------------------------------

/**
 * Execute a command with streaming output via child_process.spawn.
 *
 * @param command - The shell command string to execute.
 * @param cwd - The working directory path.
 * @param context - The tool execution context with postMessage and signal.
 * @returns A formatted string containing command output and exit code.
 */
function runCommandStreaming(
  command: string,
  cwd: string,
  context: ToolContext
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutMs = getTimeoutMs();
    let output = "";
    let isHot = false;
    let exitCode: number | null = null;
    let finished = false;

    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs = process.platform === "win32" ? ["/c", command] : ["-c", command];

    const proc = spawn(shell, shellArgs, {
      cwd,
      env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Hard timeout — configurable, extended for hot processes
    let effectiveTimeoutMs = timeoutMs;
    const hardTimer = setTimeout(() => {
      if (!finished) {
        proc.kill("SIGKILL");
        finish(null, "timeout");
      }
    }, timeoutMs);

    // Grace timer for hot processes — extends the hard timeout once
    let hotExtended = false;

    /**
     * Process a chunk of output from stdout or stderr.
     *
     * @param data - The raw buffer data from the process.
     * @param stream - Which stream produced this chunk.
     */
    function handleChunk(data: Buffer, stream: "stdout" | "stderr"): void {
      const text = data.toString("utf8");

      // Detect compilation/build processes for extended timeouts
      if (!isHot && HOT_PATTERNS.test(text)) {
        isHot = true;
        // Extend the hard timeout by 2x for hot processes (only once)
        if (!hotExtended) {
          hotExtended = true;
          clearTimeout(hardTimer);
          effectiveTimeoutMs = timeoutMs * 2;
          setTimeout(() => {
            if (!finished) {
              proc.kill("SIGKILL");
              finish(null, "timeout");
            }
          }, effectiveTimeoutMs);
        }
      }

      // Accumulate output
      if (stream === "stderr") {
        output += output.length > 0 && !output.endsWith("\n") ? `\n[stderr]\n${text}` : `[stderr]\n${text}`;
      } else {
        output += text;
      }

      // Stream to webview for live feedback
      context.postMessage({
        type: "command_output",
        content: text,
        stream,
      });

      // Mirror to VSCode terminal panel
      mirrorOutput(text);
    }

    /**
     * Finalize the command execution and resolve with formatted output.
     *
     * @param code - The process exit code, or null if killed.
     * @param reason - Optional reason for termination (e.g. "timeout").
     */
    function finish(code: number | null, reason?: string): void {
      if (finished) { return; }
      finished = true;

      clearTimeout(hardTimer);

      exitCode = code ?? (reason === "timeout" ? 124 : 1);

      // Clean and truncate output
      const cleaned = cleanTerminalOutput(output);
      let truncated = cleaned;
      if (cleaned.length > MAX_OUTPUT) {
        // Keep a head portion and a tail portion so both the start and end are visible
        const headSize = 2_000;
        const tailSize = MAX_OUTPUT - headSize - 200;
        truncated =
          cleaned.slice(0, headSize) +
          `\n\n[... output truncated (${String(cleaned.length)} chars total), showing first ${String(headSize)} + last ${String(tailSize)} chars ...]\n\n` +
          cleaned.slice(-tailSize);
      }

      const suffix = reason === "timeout"
        ? `[timed out after ${String(Math.round(effectiveTimeoutMs / 1000))}s]`
        : `[exit code: ${String(exitCode)}]`;

      resolve(`$ ${command}\n${truncated}\n${suffix}`);
    }

    // Wire up event handlers
    proc.stdout.on("data", (data: Buffer) => { handleChunk(data, "stdout"); });
    proc.stderr.on("data", (data: Buffer) => { handleChunk(data, "stderr"); });

    proc.on("close", (code: number | null) => {
      finish(code);
    });

    proc.on("error", (err: Error) => {
      if (!finished) {
        clearTimeout(hardTimer);
        finished = true;
        reject(err);
      }
    });

    // Handle abort signal (user pressed Stop / Escape)
    const onAbort = (): void => {
      if (!finished) {
        // Graceful: SIGTERM first
        proc.kill("SIGTERM");
        // Force kill after 3s grace period
        setTimeout(() => {
          if (!finished) { proc.kill("SIGKILL"); }
        }, 3000);
      }
    };
    context.signal.addEventListener("abort", onAbort, { once: true });

    proc.on("close", () => {
      context.signal.removeEventListener("abort", onAbort);
    });
  });
}

// ---------------------------------------------------------------------------
// Terminal output cleaning
// ---------------------------------------------------------------------------

/**
 * Clean terminal output: strip ANSI escape sequences, handle carriage returns
 * (progress bars), and compress repeated blank lines.
 * Preserves error-level labels (e.g. "ERROR:", "WARN:") for LLM context.
 *
 * @param raw - The raw terminal output string.
 * @returns The cleaned output string.
 */
function cleanTerminalOutput(raw: string): string {
  let text = raw;

  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const BS = String.fromCharCode(0x08);

  // Preserve error/warning color sequences as text labels before stripping
  // Red (31) → [ERROR], Yellow (33) → [WARN]
  text = text.replace(new RegExp(`${ESC}\\[31m([^${ESC}]*)${ESC}\\[0?m`, "g"), "[ERROR] $1");
  text = text.replace(new RegExp(`${ESC}\\[33m([^${ESC}]*)${ESC}\\[0?m`, "g"), "[WARN] $1");

  // Strip remaining ANSI escape sequences
  text = text.replace(new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, "g"), "");
  text = text.replace(new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, "g"), "");   // OSC sequences
  text = text.replace(new RegExp(`${ESC}[()][AB012]`, "g"), "");             // character set sequences

  // Handle carriage returns (progress bars that overwrite lines)
  text = text.replace(/[^\n]*\r(?!\n)/g, "");

  // Handle backspace sequences
  text = text.replace(new RegExp(`.${BS}`, "g"), "");

  // Compress repeated blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

// ---------------------------------------------------------------------------
// Dangerous command detection
// ---------------------------------------------------------------------------

/**
 * Checks whether a command matches any known dangerous operation pattern.
 *
 * @param command - The shell command string to check against block patterns.
 * @returns An object with the block label if blocked, or null if the command is safe.
 */
function getBlockedCommand(command: string): { label: string } | null {
  for (const blocked of CRITICAL_BLOCK_PATTERNS) {
    if (blocked.pattern.test(command)) {
      return { label: blocked.label };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cleanup — call from extension deactivate
// ---------------------------------------------------------------------------

/**
 * Disposes the terminal mirror and its event emitter. Call from extension deactivate.
 */
export function disposeCommandResources(): void {
  mirrorWriteEmitter.dispose();
  if (mirrorTerminal !== undefined) {
    mirrorTerminal.dispose();
    mirrorTerminal = undefined;
  }
}
