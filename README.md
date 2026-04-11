# Majestix Coder

**Agentic AI coding assistant for VSCode.** Reads files, writes code, runs commands, and searches your codebase autonomously — with human approval gates for every destructive action.

Powered by the [Majestix AI](https://majestix.ai) multi-model platform with automatic routing across GPT, Claude, Gemini, Nemotron, Qwen, and more.

---

## Getting Started

1. Install **Majestix Coder** from the VSCode Marketplace.
2. Sign up at [majestix.ai](https://majestix.ai) and create an API key from the dashboard.
3. Open the Majestix Coder sidebar (activity bar icon) and click **Set API Key**.
4. Start chatting — describe a task and watch the agent work.

New accounts include **500 free credits** to get started.

## Features

### Agentic Loop

Describe a task and the agent plans, reads files, edits code, runs commands, and iterates until the task is done. Every write, edit, and shell command shows an approval card so you stay in control.

### Four Agent Modes

- **Code** — full coding agent: read, write, edit, run commands.
- **Architect** — read files and write planning docs only. Great for design discussions.
- **Ask** — read-only Q&A. Never modifies your code.
- **Ask-on-write** — ask questions and make code edits in the same session.

### Multi-Model Routing

Automatic routing across the best models for each task — no manual model switching required. Or pin a specific model from the selector if you prefer.

### Session Persistence

Conversations save to `.majestix/sessions/` in your workspace and restore across restarts. Browse past sessions in the date-grouped history drawer. Long conversations use rolling LLM-generated summaries so you never hit context limits.

### Context Awareness

Every request automatically includes:
- Active file, selection, and diagnostics
- Open editor tabs and recently edited files
- Workspace structure and git status
- Project rules from `.majestix-rules` / `.clinerules`
- Workspace Problems panel
- Files you drag-and-drop or `@mention`

### Approval Controls

- `none` — always ask (default, safest)
- `readOnly` — auto-approve safe commands like `ls`, `cat`, `git status`
- `all` — auto-approve everything (use with caution)

Optional command whitelist restricts shell execution to specific tokens. Per-session "Always allow" toggle lets you trust a single run without changing global settings.

### Cost Awareness

Live credit balance in the status bar, per-run cost estimate during agent loops, and a configurable cost-warning threshold that pauses expensive runs before they blow your budget.

### Secure by Default

- API keys stored in the OS keychain (never in settings.json or disk)
- All file operations sandboxed to your workspace
- No external telemetry — diagnostics go only to the VSCode Output channel
- Destructive operations require explicit approval

## Commands

| Command | Keybinding |
|---|---|
| Ask AI | `Cmd/Ctrl+Shift+I` |
| Explain Code | `Cmd/Ctrl+Shift+E` |
| Fix Error | `Cmd/Ctrl+Shift+F` |
| Review Code | `Cmd/Ctrl+Shift+R` |
| Send Terminal Output to Chat | `Cmd/Ctrl+Shift+T` |
| Refactor | — |
| Generate Code | — |
| Generate Commit Message | — |
| Generate PR Description | — |
| New Chat | — |
| Session History | — |
| Run Todo Items as Agent Tasks | — |
| Create Rules File | — |

All commands are available from the Command Palette under **Majestix**. Right-click a selection in the editor for quick access to Explain / Refactor / Fix / Review.

## Settings

| Setting | Default | Description |
|---|---|---|
| `majestix.apiUrl` | `https://api.majestix.ai` | Backend API URL |
| `majestix.defaultModel` | `""` (auto-route) | Pin a specific model |
| `majestix.defaultMode` | `code` | Default agent mode for new chats |
| `majestix.autoApprove` | `none` | Auto-approve level |
| `majestix.maxIterations` | `50` | Max loop iterations per task |
| `majestix.commandTimeout` | `60` | Shell command timeout (seconds) |
| `majestix.costWarningThreshold` | `100` | Pause above this many credits (0 = disabled) |
| `majestix.commandWhitelist` | `[]` | Optional command token whitelist |
| `majestix.maxContextFiles` | `5` | Max context files per request |
| `majestix.sessionHistory.enabled` | `true` | Persist conversation history |
| `majestix.telemetry.enabled` | `true` | Local diagnostics in Output channel |
| `majestix.terminalMirror` | `false` | Mirror agent commands to a real terminal panel |

## Requirements

- VSCode `1.85.0` or newer
- Internet connection
- A Majestix API key — [create one here](https://majestix.ai)

## Privacy

Majestix Coder sends your prompts, file contents you attach or `@mention`, and the environment context described above to the Majestix API for model inference. We do not train on your data. See the full privacy policy at [majestix.ai/privacy](https://majestix.ai/privacy).

## Support

- Issues: [github.com/MajestixAi/Majestix-Coder/issues](https://github.com/MajestixAi/Majestix-Coder/issues)
- Docs: [docs.majestix.ai](https://docs.majestix.ai)
- Dashboard: [majestix.ai](https://majestix.ai)

## License

MIT © Majestix AI LLC
