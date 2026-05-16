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
const ABORT_GRACE_MS = 1_000;

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
  // privilege / system takeover
  { label: "privilege escalation", pattern: /\bsudo\b/ },
  { label: "privilege escalation", pattern: /\bsu\s+-/ },
  { label: "windows admin elevation", pattern: /Start-Process\s+.*-Verb\s+runAs/i },

  // disk / filesystem destructive outside normal coding
  { label: "disk formatting", pattern: /\bmkfs\b|\bformat\s+[A-Z]:/i },
  { label: "disk overwrite", pattern: /\bdd\s+.*\bof=\/dev\// },
  { label: "disk partitioning", pattern: /\b(fdisk|parted|diskutil)\b/i },

  // fork bombs / shutdowns
  { label: "fork bomb", pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/ },
  { label: "shutdown/reboot", pattern: /\b(shutdown|reboot|halt|poweroff)\b/i },

  // exfiltration / network shells
  { label: "reverse shell", pattern: /\bnc\b.*\s-e\s+\/bin\//i },
  { label: "reverse shell", pattern: /bash\s+-i\s+>&\s*\/dev\/tcp/i },
  { label: "secret exfiltration", pattern: /\b(curl|wget)\b.*\$\(\s*(cat|grep).*\.(env|pem|key|aws|credentials)/i },

  // crypto miners / known abuse
  { label: "crypto miner", pattern: /\b(xmrig|minerd|cpuminer)\b/i },
];

// Patterns that are allowed only if every path argument is inside workspace.
const PATH_GATED_DESTRUCTIVE = /\b(rm|mv|chmod|chown|truncate|shred)\b/i;

// ---------------------------------------------------------------------------
// Command output rewriting — prevent runaway output
// ---------------------------------------------------------------------------

/** Commands likely to dump huge output if unbounded. */
const HIGH_OUTPUT_PATTERNS: { pattern: RegExp; rewrite: (cmd: string) => string }[] = [
  // grep -R / rg without max-count
  {
    pattern: /^\s*grep\s+(-[A-Za-z]*R[A-Za-z]*|-r)\b(?!.*\|\s*head)/,
    rewrite: (cmd) => `${cmd} | head -200`,
  },
  {
    pattern: /^\s*rg\b(?!.*(--max-count|-m)\b)(?!.*\|\s*head)/,
    rewrite: (cmd) => `${cmd} --max-count 200`,
  },
  // find without maxdepth or head
  {
    pattern: /^\s*find\s+\S+(?!.*-maxdepth)(?!.*\|\s*head)/,
    rewrite: (cmd) => `${cmd} | head -500`,
  },
  // cat huge-ish glob/recursive patterns
  {
    pattern: /^\s*cat\s+.*(\*|\.log|node_modules|dist|build)(?!.*\|\s*head)/,
    rewrite: (cmd) => `${cmd} | head -500`,
  },
];

/**
 * Rewrites commands that are likely to produce massive output by adding simple limits.
 *
 * @param command - The original shell command.
 * @returns The rewritten command, or the original if no rewrite is needed.
 */
function rewriteForOutputSafety(command: string): string {
  // Don't rewrite if user already pipes/redirects in a way that limits output.
  if (/\b(head|tail|less|more|sed\s+-n|awk\s+.*NR\s*[<]=)\b/.test(command)) {
    return command;
  }

  for (const { pattern, rewrite } of HIGH_OUTPUT_PATTERNS) {
    if (pattern.test(command)) {
      return rewrite(command);
    }
  }
  return command;
}

// ---------------------------------------------------------------------------
// Terminal mirroring
// ---------------------------------------------------------------------------

let mirrorTerminal: vscode.Terminal | undefined;
const mirrorWriteEmitter: vscode.EventEmitter<string> = new vscode.EventEmitter<string>();

/**
 * Ensure a VSCode terminal exists for mirroring command output.
 * Uses a pseudoterminal so we can write streaming output directly.
 *
 * @returns The terminal used for mirrored command output.
 */
function ensureMirrorTerminal(): vscode.Terminal {
  if (mirrorTerminal !== undefined) {
    return mirrorTerminal;
  }

  const pty: vscode.Pseudoterminal = {
    onDidWrite: mirrorWriteEmitter.event,
    open: () => {
      mirrorWriteEmitter.fire("\x1b[36mMajestix Command Output\x1b[0m\r\n");
    },
    close: () => { /* no-op */ },
  };

  const term = vscode.window.createTerminal({ name: "Majestix Command Output", pty });
  mirrorTerminal = term;
  return term;
}

/**
 * Writes text to the mirror terminal if enabled.
 *
 * @param text - Text to write.
 */
function mirrorOutput(text: string): void {
  const enabled = getMirrorEnabled();
  if (!enabled) { return; }
  const term = ensureMirrorTerminal();
  term.show(true);
  // Normalize LF to CRLF for terminal rendering
  mirrorWriteEmitter.fire(text.replace(/\n/g, "\r\n"));
}

/**
 * Returns the configured command timeout in milliseconds.
 *
 * @returns Command timeout in milliseconds.
 */
function getTimeoutMs(): number {
  const seconds = vscode.workspace.getConfiguration("majestix").get<number>("commandTimeout", 60);
  return seconds * 1000;
}

/**
 * Sleeps for the requested duration, but resolves early if the agent is aborted.
 *
 * @param ms - Delay in milliseconds.
 * @param signal - Abort signal from the active agent run.
 * @returns A promise that resolves after the delay or when aborted.
 */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Terminate a spawned command. On POSIX, commands are launched as their own
 * process group so killing `-pid` also terminates children started by the shell
 * (npm/node/test watchers/etc.), which prevents the Stop button from hanging.
 *
 * @param proc - The spawned child process.
 * @param signal - Signal to send.
 */
function killCommandProcess(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (proc.pid === undefined) { return; }
  try {
    if (process.platform !== "win32") {
      process.kill(-proc.pid, signal);
    } else {
      proc.kill(signal);
    }
  } catch {
    try { proc.kill(signal); } catch { /* process already exited */ }
  }
}

/**
 * Checks whether terminal mirroring is enabled in workspace settings.
 *
 * @returns True if command output should be mirrored to a terminal.
 */
function getMirrorEnabled(): boolean {
  return vscode.workspace.getConfiguration("majestix").get<boolean>("terminalMirror", false);
}

// ---------------------------------------------------------------------------
// Whitelist enforcement
// ---------------------------------------------------------------------------

/**
 * Checks optional command whitelist setting.
 * If whitelist is non-empty, command must start with one of the allowed tokens.
 *
 * @param command - The command to check.
 * @returns Error message if blocked, otherwise null.
 */
function checkWhitelist(command: string): string | null {
  const whitelist = vscode.workspace.getConfiguration("majestix").get<string[]>("commandWhitelist", []);
  if (whitelist.length === 0) { return null; }

  const trimmed = command.trim();
  const allowed = whitelist.some((token) => trimmed.startsWith(token));
  if (!allowed) {
    return `Command blocked by whitelist. Allowed prefixes: ${whitelist.join(", ")}`;
  }
  return null;
}

/**
 * Checks path-gated destructive commands to ensure they only target workspace paths.
 *
 * @param command - The shell command string.
 * @param workspaceRoot - The workspace root URI.
 * @returns Error message if unsafe, otherwise null.
 */
function checkPathGatedDestructive(command: string, workspaceRoot: vscode.Uri): string | null {
  if (!PATH_GATED_DESTRUCTIVE.test(command)) { return null; }

  // Extract simple path-like tokens after destructive commands.
  // This is intentionally conservative; if we can't reason about it, require manual review.
  const tokens = command.split(/\s+/).filter((t) => t.length > 0);
  const destructiveIndex = tokens.findIndex((t) => /^(rm|mv|chmod|chown|truncate|shred)$/.test(t));
  if (destructiveIndex === -1) { return null; }

  const pathTokens = tokens.slice(destructiveIndex + 1)
    .filter((t) => !t.startsWith("-") && !/^[0-7]{3,4}$/.test(t));

  for (const token of pathTokens) {
    // Skip shell operators and obvious non-paths
    if (/^(\||&&|\|\||;|>|<|2>|&>)$/.test(token)) { continue; }
    if (token.includes("$") || token.includes("`")) {
      return "Destructive command blocked: dynamic shell expansion in path is not allowed.";
    }

    try {
      const unquoted = token.replace(/^['"]|['"]$/g, "");
      const resolved = path.isAbsolute(unquoted)
        ? vscode.Uri.file(unquoted)
        : resolveWorkspacePath(workspaceRoot, unquoted);

      if (!resolved.fsPath.startsWith(workspaceRoot.fsPath)) {
        return `Destructive command blocked: path outside workspace (${unquoted})`;
      }
    } catch {
      return `Destructive command blocked: unsafe path (${token})`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export const executeCommandTool: ToolHandler = {
  definition: {
    name: "execute_command",
    description:
      "Execute a shell command in the workspace. Requires user approval unless auto-approved by settings.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        cwd: { type: "string", description: "Working directory relative to workspace root (optional)" },
      },
      required: ["command"],
    },
  },
  requiresApproval: () => true,
  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (command.length === 0) {
      return { tool_use_id: "", content: "Error: command is required", is_error: true };
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders === undefined || workspaceFolders.length === 0) {
      return { tool_use_id: "", content: "Error: no workspace folder open", is_error: true };
    }

    const workspaceRoot = workspaceFolders[0].uri;
    let cwd = workspaceRoot.fsPath;
    if (typeof input.cwd === "string" && input.cwd.length > 0) {
      try {
        cwd = resolveWorkspacePath(workspaceRoot, input.cwd).fsPath;
      } catch (e: unknown) {
        return {
          tool_use_id: "",
          content: `Error: invalid cwd: ${e instanceof Error ? e.message : String(e)}`,
          is_error: true,
        };
      }
    }

    // --- Safety: critical blocklist ---
    const blocked = getBlockedCommand(command);
    if (blocked !== null) {
      trackEvent("command.blocked", { reason: blocked.label, command: command.slice(0, 100) });
      return {
        tool_use_id: "",
        content: `Command blocked for safety: ${blocked.label}.`,
        is_error: true,
      };
    }

    // --- Safety: path-gated destructive commands ---
    const pathGateError = checkPathGatedDestructive(command, workspaceRoot);
    if (pathGateError !== null) {
      trackEvent("command.blocked", { reason: "path_gate", command: command.slice(0, 100) });
      return {
        tool_use_id: "",
        content: pathGateError,
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
      await sleepAbortable(delay, context.signal);
      if (context.signal.aborted) {
        return {
          tool_use_id: "",
          content: "Command cancelled before execution.",
          is_error: true,
        };
      }
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
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs = process.platform === "win32" ? ["/c", command] : ["-c", command];

    const proc = spawn(shell, shellArgs, {
      cwd,
      env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let effectiveTimeoutMs = timeoutMs;
    let hotExtended = false;

    const scheduleTimeout = (): void => {
      if (timeoutTimer !== undefined) { clearTimeout(timeoutTimer); }
      timeoutTimer = setTimeout(() => {
        if (!finished) {
          killCommandProcess(proc, "SIGTERM");
          killTimer = setTimeout(() => {
            killCommandProcess(proc, "SIGKILL");
          }, ABORT_GRACE_MS);
          finish(null, "timeout");
        }
      }, effectiveTimeoutMs);
    };

    scheduleTimeout();

    /**
     * Process a chunk of output from stdout or stderr.
     *
     * @param data - The raw buffer data from the process.
     * @param stream - Which stream produced this chunk.
     */
    function handleChunk(data: Buffer, stream: "stdout" | "stderr"): void {
      if (finished) { return; }
      const text = data.toString("utf8");

      // Detect compilation/build processes for extended timeouts.
      if (!isHot && HOT_PATTERNS.test(text)) {
        isHot = true;
        if (!hotExtended) {
          hotExtended = true;
          effectiveTimeoutMs = timeoutMs * 2;
          scheduleTimeout();
        }
      }

      // Accumulate output.
      if (stream === "stderr") {
        output += output.length > 0 && !output.endsWith("\n") ? `\n[stderr]\n${text}` : `[stderr]\n${text}`;
      } else {
        output += text;
      }

      // Stream to webview for live feedback.
      context.postMessage({
        type: "command_output",
        content: text,
        stream,
      });

      // Mirror to VSCode terminal panel.
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

      if (timeoutTimer !== undefined) { clearTimeout(timeoutTimer); }
      exitCode = code ?? (reason === "timeout" ? 124 : reason === "aborted" ? 130 : 1);

      // Clean and truncate output.
      const cleaned = cleanTerminalOutput(output);
      let truncated = cleaned;
      if (cleaned.length > MAX_OUTPUT) {
        const headSize = 2_000;
        const tailSize = MAX_OUTPUT - headSize - 200;
        truncated =
          cleaned.slice(0, headSize) +
          `\n\n[... output truncated (${String(cleaned.length)} chars total), showing first ${String(headSize)} + last ${String(tailSize)} chars ...]\n\n` +
          cleaned.slice(-tailSize);
      }

      const suffix = reason === "timeout"
        ? `[timed out after ${String(Math.round(effectiveTimeoutMs / 1000))}s]`
        : reason === "aborted"
          ? "[aborted by user]"
          : `[exit code: ${String(exitCode)}]`;

      resolve(`$ ${command}\n${truncated}\n${suffix}`);
    }

    // Wire up event handlers.
    proc.stdout.on("data", (data: Buffer) => { handleChunk(data, "stdout"); });
    proc.stderr.on("data", (data: Buffer) => { handleChunk(data, "stderr"); });

    proc.on("close", (code: number | null) => {
      context.signal.removeEventListener("abort", onAbort);
      if (killTimer !== undefined) { clearTimeout(killTimer); }
      finish(code);
    });

    proc.on("error", (err: Error) => {
      if (timeoutTimer !== undefined) { clearTimeout(timeoutTimer); }
      if (killTimer !== undefined) { clearTimeout(killTimer); }
      if (!finished) {
        finished = true;
        reject(err);
      }
    });

    // Handle abort signal (user pressed Stop / Escape).
    const onAbort = (): void => {
      if (!finished) {
        output += output.length > 0 && !output.endsWith("\n") ? "\n[command aborted by user]\n" : "[command aborted by user]\n";
        context.postMessage({
          type: "command_output",
          content: "\n[command aborted by user]\n",
          stream: "stderr",
        });
        mirrorOutput("\n[command aborted by user]\n");

        // Graceful: SIGTERM first, to the whole process group on POSIX.
        killCommandProcess(proc, "SIGTERM");
        // Force kill after a short grace period. The promise is resolved
        // immediately so the webview Stop button never waits for stubborn
        // child processes or inherited pipes to close.
        killTimer = setTimeout(() => {
          killCommandProcess(proc, "SIGKILL");
        }, ABORT_GRACE_MS);
        finish(null, "aborted");
      }
    };

    context.signal.addEventListener("abort", onAbort, { once: true });
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
