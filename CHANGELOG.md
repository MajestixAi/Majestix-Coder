# Changelog

All notable changes to the Majestix Coder extension will be documented in this file.

## [Unreleased]

### Model Compatibility

- **Expanded tool name aliases** — added mappings for Google Gemini (`write`, `readFile`), DeepSeek (`save_file`, `read_file_content`), and other common conventions (`write_file`, `file_edit`, `patch_file`, `edit`). Models that previously failed to invoke file tools will now resolve correctly.
- **Parameter normalization for `write_to_file`** — handles `file` → `path`, `file_text` → `content`, and `filePath` → `path` so Google and DeepSeek models can write files without parameter name errors.
- **Alias resolution telemetry** — all tool alias resolutions are now tracked via `tool.alias_resolved` events for debugging cross-model compatibility issues.

### Security & Safety

- **Critical command blocking** — expanded blocked patterns to cover privilege escalation (`sudo`, `su -`, Windows `runAs`), disk formatting/partitioning, network attacks (`nmap`, `hping`, `masscan`), remote shells (`nc -e`, `bash -i`, `python -c 'import pty'`), and dangerous pipe-to-shell patterns.
- **Path-gated destructive commands** — destructive commands (`rm`, `mv`, `cp`, `chmod`, `chown`, `mkfs`, `dd`, `format`, etc.) are now blocked if they reference paths outside the workspace root or contain shell escape sequences.
- **Cost-warning approval reset** — new setting `majestix.requireApprovalAfterCostWarning` (default: `true`). After acknowledging a cost warning, auto-approval is disabled for the remainder of the run so the user stays in the loop for subsequent expensive operations.

### Reliability

- **Stop-button responsiveness** — pressing Stop while an approval card is shown now immediately denies the pending approval and aborts the command cleanly.
- **Command timeout rewrite** — timeouts now send `SIGTERM` first, then `SIGKILL` after a 1-second grace period. Timeout timer is reschedulable and abort-aware.
- **Process group killing on POSIX** — `detached: true` on non-Windows; termination sends signals to the process group (`-${pid}`) so orphaned children are also killed.
- **Circuit breaker** — exponential backoff delays before retrying after recent failures; backoff is abort-aware so pressing Stop cancels the wait.
- **Hot-process detection** — compilation/build processes still get 2× timeout extension, but the timeout is properly rescheduled instead of creating overlapping timers.
- **Output race fix** — added early-return guard in output handler to prevent data races when the process finishes just as a chunk arrives.
- **Reset settings completeness** — reset now also clears `requireApprovalAfterCostWarning`, `commandWhitelist`, and `terminalMirror`.
- **Session ignore** — `.majestix/` added to `.gitignore` so session files are never committed.

### UX

- **Context preserved on Stop** — pressing Stop no longer discards the partial assistant response. The streamed text is flushed into the conversation and saved to the session, so follow-up messages have full context.
- **Send-while-streaming** — you can now type and send a new message while the agent is running. The current run is gracefully aborted and the new message starts immediately, giving a natural "interrupt and redirect" workflow. Escape still stops without sending.

## [1.0.0] - 2026-04-11

Initial public release.

### Features

- **Agentic coding loop** — reads files, writes code, runs commands, and searches your codebase autonomously with human approval gates for destructive actions.
- **Four agent modes** — Code (full tools), Architect (read + plan docs), Ask (read-only Q&A), and Ask-on-write (ask questions while still allowing edits).
- **Multi-model backend** — powered by the Majestix platform with automatic routing across GPT, Claude, Gemini, Nemotron, Qwen, and more.
- **Sidebar chat UI** — Preact-based webview with thinking blocks, tool cards, approval cards, and live agent status (step counter, running cost, elapsed time).
- **Session persistence** — conversations saved to `.majestix/sessions/` and restored across VSCode restarts, with a date-grouped history drawer.
- **Conversation compaction** — rolling LLM summary every 20 messages so long sessions never hit context limits.
- **Context-aware prompts** — active file, open tabs, recently edited files, workspace structure, git status, and project rules (`.majestix-rules`) automatically included.
- **File attachments** — drag-and-drop, `@filename` fuzzy search, and native file picker.
- **Terminal integration** — send terminal output to chat with one click or `Cmd+Shift+T`.
- **Approval controls** — configurable auto-approve levels (`none`, `readOnly`, `all`), per-session "always allow" toggle, and optional command whitelist.
- **Cost awareness** — status-bar credit balance and configurable cost-warning threshold that pauses expensive runs.
- **Secure API key storage** — keys stored in the OS keychain via VSCode `SecretStorage`, never written to disk or settings.
- **19 commands** including Ask AI, Explain Code, Refactor, Fix Error, Generate Code, Review Code, Generate Commit Message, Generate PR Description, and more.
