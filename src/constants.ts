// ── File I/O limits ────────────────────────────────────────────────────────

/** Maximum file size (bytes) for read_file when no line range is specified. */
export const MAX_FILE_SIZE = 10_000_000;

/** Maximum content length (bytes) for write_to_file. */
export const MAX_WRITE_SIZE = 10_000_000;

/** Maximum file size (bytes) for search_files. */
export const MAX_SEARCH_FILE_SIZE = 10_000_000;

/** Maximum number of results returned by search_files. */
export const MAX_SEARCH_RESULTS = 100;

/** Maximum number of files returned by findFiles in search. */
export const MAX_FIND_FILES = 1_000;

// ── Tool result limits ────────────────────────────────────────────────────

/** Hard cap on any single tool result content (chars). */
export const MAX_TOOL_RESULT_CHARS = 30_000;
export const TOOL_RESULT_HEAD = 12_000;
export const TOOL_RESULT_TAIL = 12_000;

/** Maximum command output (chars) before truncation. */
export const MAX_COMMAND_OUTPUT = 10_000;

// ── Command execution ─────────────────────────────────────────────────────

/** Grace period (ms) between SIGTERM and SIGKILL when aborting a command. */
export const ABORT_GRACE_MS = 1_000;

/** Default command timeout (seconds). */
export const DEFAULT_COMMAND_TIMEOUT_S = 60;

// ── Agent loop ────────────────────────────────────────────────────────────

/** Default maximum agent iterations. */
export const DEFAULT_MAX_ITERATIONS = 50;

/** Maximum transient API retries before aborting. */
export const MAX_TRANSIENT_RETRIES = 3;

/** Maximum number of messages kept when resuming a long session. */
export const MAX_RESUME_MESSAGES = 20;

// ── Circuit breaker (command execution) ───────────────────────────────────

/** Consecutive command failures before the breaker trips. */
export const BREAKER_FAILURE_THRESHOLD = 3;

/** Backoff durations (ms) for each consecutive failure: 1s → 2s → 4s. */
export const BACKOFF_SCHEDULE_MS = [1_000, 2_000, 4_000];

/** Cooldown period (ms) after the breaker trips. */
export const BREAKER_COOLDOWN_MS = 30_000;

/** Sliding window (ms) in which failures count toward the breaker. */
export const FAILURE_WINDOW_MS = 5 * 60 * 1_000;

// ── Post-write diagnostics ────────────────────────────────────────────────

/** Delay (ms) after a file write before checking diagnostics. */
export const POST_WRITE_DIAGNOSTIC_DELAY_MS = 100;

/** Maximum errors shown in post-write diagnostic feedback. */
export const MAX_DIAGNOSTIC_ERRORS = 5;

/** Maximum warnings shown in post-write diagnostic feedback. */
export const MAX_DIAGNOSTIC_WARNINGS = 3;

// ── API / SSE ─────────────────────────────────────────────────────────────

/** Stream timeout (ms) — no data received in this window. */
export const SSE_CHUNK_TIMEOUT_MS = 60_000;

/** Maximum retries for initial API fetch (before streaming). */
export const API_INITIAL_RETRY_COUNT = 3;

/** Base delay (ms) for API initial retry backoff. */
export const API_INITIAL_RETRY_BASE_MS = 1_000;

// ── Agent config ──────────────────────────────────────────────────────────

/** Cost warning threshold in credits. */
export const DEFAULT_COST_WARNING_THRESHOLD = 100;

/** Auto-approve duration (ms) — 10 minutes. */
export const AUTO_APPROVE_DURATION_MS = 10 * 60 * 1_000;

// ── Backups ───────────────────────────────────────────────────────────────

/** Maximum number of file backups kept in memory. */
export const MAX_BACKUPS = 50;

// ── Environment ───────────────────────────────────────────────────────────

/** Maximum number of open tabs shown in environment details. */
export const MAX_OPEN_TABS = 15;

/** Maximum number of workspace structure entries shown. */
export const MAX_WORKSPACE_STRUCTURE = 30;

/** Maximum number of git status lines shown. */
export const MAX_GIT_STATUS_LINES = 15;

/** Maximum number of recently edited files shown. */
export const MAX_RECENT_EDITS = 10;
