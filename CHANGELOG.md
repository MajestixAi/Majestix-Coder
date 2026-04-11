# Changelog

All notable changes to the Majestix Coder extension will be documented in this file.

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
