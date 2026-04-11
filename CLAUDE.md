# Inference VSCode Extension — AI Context

Agentic AI coding assistant for VSCode (branded **Majestix AI**). Reads files, writes code, runs commands, and searches the user's codebase autonomously with human approval gates.

**Git remote**: `MajestixAi/inference-vscode` (branch: `dev`)
**Backend**: Cloud Run harness API — see `../inference-harness/`

## Tech Stack

- **VSCode Extension API** (v1.85+), WebviewViewProvider for sidebar
- **TypeScript** (strict mode), **esbuild** (CommonJS output)
- **Webview**: Preact app (`src/webview/`) bundled to `dist/webview.js` — NOT inline HTML in chat-panel.ts
- **Auth**: API key in VSCode `SecretStorage` (OS keychain)
- **Rendering**: `marked` + `highlight.js` for markdown/code in webview
- **No test framework** currently — verify via `npm run typecheck && npm run lint && npm run build`

## Project Structure

```
src/
├── extension.ts                 # Entry point: activate/deactivate, register commands
├── auth/
│   └── api-key.ts               # ApiKeyManager — SecretStorage wrapper, promptForKey(), validation
├── api/
│   └── client.ts                # MajestixClient — HTTP client, codeStream() SSE, ModelInfo type
├── agent/
│   ├── loop.ts                  # runAgentLoop() — send → stream → tools → execute → repeat
│   ├── system-prompt.ts         # buildSystemPrompt(), getEnvironmentDetails(), loadProjectRules()
│   ├── compact.ts               # Conversation compaction — LLM summary every 20 msgs, rolls forward
│   ├── think-parser.ts          # <think> tag parser — isolated from output/tool logic
│   ├── token-budget.ts          # Token math + context trimming (fallback)
│   ├── tool-utils.ts            # Approval UI helpers + aliased-input normalization
│   └── error-tracker.ts         # Consecutive failure tracking
├── sessions/
│   ├── types.ts                 # StoredSession, SessionSummary, Message protocol types
│   └── session-store.ts         # SessionStore — file CRUD, index mgmt, title generation, max 50
├── tools/
│   ├── types.ts                 # ToolHandler, ToolResult, ToolContext interfaces
│   ├── registry.ts              # Tool registry with per-mode filtering (modeTools map) + alias map
│   ├── read-file.ts             # Read file with line numbers and range support
│   ├── write-file.ts            # Create/overwrite files (requires approval)
│   ├── write-plan.ts            # Write a plan/notes file (architect mode)
│   ├── edit-file.ts             # Search-and-replace edits (requires approval, uniqueness check)
│   ├── apply-patch.ts           # Apply unified diff patch (requires approval)
│   ├── list-files.ts            # Directory listing with gitignore filtering
│   ├── search-files.ts          # Regex search across workspace (uses VS Code findFiles)
│   ├── execute-command.ts       # Shell command execution (approval, configurable timeout)
│   ├── attempt-completion.ts    # Signal task completion with summary
│   ├── diff-match.ts            # Diff/patch utility (used by apply-patch)
│   └── file-backup.ts           # File backup before destructive edits
├── commands/
│   ├── ask.ts                   # "Ask AI" — free-form question with file context
│   ├── explain.ts               # "Explain Code" — explain selected code
│   ├── refactor.ts              # "Refactor" — refactor with user instruction
│   ├── fix.ts                   # "Fix Error" — fix selected code or diagnostics
│   ├── generate.ts              # "Generate Code" — generate from description
│   └── review.ts                # "Review Code" — code review on selection/file
├── context/
│   └── active-file.ts           # ActiveFileContext, workspace diagnostics, edit tracking
├── webview/                     # Preact app (bundled to dist/webview.js by esbuild)
│   ├── App.tsx                  # Root Preact component
│   ├── index.tsx                # Webview entry point
│   ├── state.ts                 # Shared webview state
│   ├── types.ts                 # Webview-specific types
│   ├── utils.ts                 # Webview utilities
│   ├── styles/                  # CSS
│   └── components/              # ChatMessage, ThinkingBlock, ToolCard, ApprovalCard, etc.
├── sidebar/
│   ├── chat-panel.ts            # WebviewViewProvider — mounts Preact app, handles all messages
│   ├── reveal.ts                # Sidebar reveal & placement helpers
│   └── webview/
│       └── markdown.ts          # Markdown rendering (marked + highlight.js + table normalization)
└── util/
    ├── credits.ts               # Status bar credit balance (auto-refresh 60s)
    ├── telemetry.ts             # Local telemetry (Output channel only, no external)
    └── path-safety.ts           # Path validation & workspace sandboxing
```

## Architecture

### Agentic Loop (`agent/loop.ts`)

1. User sends message → extension builds system prompt + environment context
2. Calls `POST /code` on harness API with full messages array + tool schemas
3. Backend streams SSE: `text`, `tool_use`, `done` events
4. Extension executes tool calls locally (with approval for destructive tools)
5. Appends `tool_result` to conversation, calls `/code` again
6. Repeats until `attempt_completion` or max iterations or user abort

Each `/code` call = one LLM round-trip. Extension owns the conversation and loop — backend is a model proxy.

**Key constants** in `loop.ts`:
- `DEFAULT_MAX_ITERATIONS = 50` (overridden by `majestix.maxIterations` setting)
- `MAX_OUTPUT_TOKENS = 16_384`
- `DEFAULT_CONTEXT_WINDOW = 200_000`
- Automatic context pruning when conversation exceeds token budget (keeps last 8 messages)

### Conversation Compaction (`agent/compact.ts`)

Every 20 messages, the agent loop calls an LLM to produce a rolling summary of the conversation so far. The summary is prepended to the next request, allowing long conversations to continue without hitting context limits. Uses the same `/code` endpoint with a lightweight model.

### Webview Architecture

The sidebar UI is a **Preact app** (`src/webview/`) bundled by esbuild into `dist/webview.js`. `chat-panel.ts` is a `WebviewViewProvider` that loads the bundle into the webview HTML and handles all `postMessage` / `onDidReceiveMessage` communication. This is NOT the old inline-HTML approach.

**retainContextWhenHidden: true** is set on both sidebar panes (primary + secondary) so the Preact app's state and any running agent loop are preserved when the user switches to another extension's panel.

### SSE Protocol

```
data: {"type": "text", "content": "Let me read..."}
data: {"type": "tool_use", "id": "toolu_01abc", "name": "read_file", "input": {"path": "src/index.ts"}}
data: {"type": "done", "model": "claude-sonnet", "credits_used": 0.85, "usage": {...}}
```

### Webview Communication

Extension ↔ Webview via `postMessage()` / `onDidReceiveMessage()`. Key message types:

**Webview → Extension**: `sendAgent`, `stop`, `approvalResponse`, `keyStatus`, `keySet`, `keyClear`, `searchFiles`, `pickFileByPath`, `dropFiles`, `dropUris`, `session:new`, `session:load`, `session:delete`, `session:rename`, `setMode`, `setThinking`, `downloadChat`, `copyToClipboard`, `pastePath`, `openSettings`

**Extension → Webview**: `thinking`, `text`, `tool_call`, `tool_result`, `approval_request`, `completion`, `credits`, `error`, `done`, `stopped`, `models`, `session:loaded`, `session:list`, `session:active`, `session:deleted`, `filesAttached`, `fileSearchResults`, `keyStatus`, `focusInput`, `clearPastedPath`

## Tools (9)

| Tool | Approval | Description |
|------|----------|-------------|
| `read_file` | Auto | Read file with line numbers, supports `start_line`/`end_line` |
| `write_to_file` | Required | Create or overwrite file, shows Allow/Reject card |
| `write_plan` | Required | Write a plan/notes file (architect mode only) |
| `edit_file` | Required | Search-and-replace, checks `old_text` uniqueness |
| `apply_patch` | Required | Apply a unified diff patch to a file |
| `execute_command` | Required | Shell via `child_process`, configurable timeout |
| `search_files` | Auto | Regex search across workspace |
| `list_files` | Auto | Directory listing, respects gitignore |
| `attempt_completion` | Auto | Signal task done, shows completion card |

### Mode-based tool filtering (`tools/registry.ts`)

| Mode | Available Tools |
|------|-----------------|
| **code** | read_file, write_to_file, edit_file, apply_patch, execute_command, search_files, list_files, attempt_completion |
| **architect** | read_file, write_plan, search_files, list_files, attempt_completion |
| **ask** | read_file, search_files, list_files, attempt_completion |
| **askonwrite** | read_file, write_to_file, edit_file, apply_patch, execute_command, search_files, list_files, attempt_completion |

### Tool Alias Map (`tools/registry.ts`)

Models trained on SWE-bench/OpenHands data emit non-canonical tool names. `resolveToolName()` maps these to our tools:
- `str_replace_editor`, `str_replace_command` → `edit_file`
- `bash`, `run_command`, `terminal`, `shell` → `execute_command`
- `view`, `open_file`, `cat_file` → `read_file`
- `patch`, `diff` → `apply_patch`
- `submit`, `finish` → `attempt_completion`

## Approval Flow

1. Agent loop calls `requestApproval(toolName, description, detail?)`
2. Extension posts `approval_request` to webview
3. Webview shows **Allow** / **Reject** + optional **"Always allow this session"** checkbox
4. User clicks → webview posts `approvalResponse` → loop continues or rejects

**Auto-approve levels** (`majestix.autoApprove` setting):
- `none` — always ask (default)
- `readOnly` — auto-approve read-only commands (detected via regex in `loop.ts`)
- `all` — auto-approve everything

**Session-level toggle**: "Always allow this session" checkbox auto-approves remaining operations.

## Context System (`agent/system-prompt.ts`, `context/active-file.ts`)

### System prompt context (refreshed per agent loop)
- OS, shell, workspace name and root path
- Active file path and language
- Open editor tabs (up to 15, via `tabGroups`)
- Recently edited files (last 10 minutes, tracked via `onDidChangeTextDocument`)
- Top-level workspace directory structure (excludes node_modules, .git, etc.)
- Git branch, status (`--porcelain`), staged diff summary
- Project rules from `.majestix-rules` / `.majestix/rules` / `.clinerules`

### Per-message context (injected into user message by chat-panel.ts)
- Active file path + language + selection + diagnostics
- Workspace-wide diagnostics from Problems panel (up to 20)
- Attached file contents (attach button, drag-drop, @-mention)

## Session Persistence (`sessions/session-store.ts`)

```
{workspace}/.majestix/sessions/
  _index.json          — SessionSummary[] (lightweight list)
  {uuid}.json          — StoredSession (full conversation + compact_summary)
```

- Saves after each agent loop completes
- Active session ID persists in `workspaceState` → auto-restores on restart
- Max 50 sessions, oldest auto-pruned
- Sessions can be renamed, searched, deleted
- `compact_summary` field carries the rolling compaction summary across saves
- No workspace folder = no persistence

## Commands (13)

| Command | Keybinding | Context Menu |
|---------|------------|--------------|
| `majestix.ask` | `Cmd+Shift+I` | No |
| `majestix.explain` | `Cmd+Shift+E` | Yes (selection) |
| `majestix.refactor` | — | Yes (selection) |
| `majestix.fix` | `Cmd+Shift+F` | Yes (selection) |
| `majestix.generate` | — | No |
| `majestix.review` | `Cmd+Shift+R` | Yes (selection) |
| `majestix.setApiKey` | — | No |
| `majestix.clearApiKey` | — | No |
| `majestix.newChat` | `Cmd+Shift+N` | No |
| `majestix.sessionHistory` | — | No |
| `majestix.sendTerminal` | — | No |
| `majestix.createRulesFile` | — | No |
| `majestix.moveToSecondarySidebar` | — | No |

## Settings (10)

| Setting | Default | Description |
|---------|---------|-------------|
| `majestix.apiUrl` | Cloud Run URL | Backend API URL |
| `majestix.defaultModel` | `""` (auto-route) | Default model key |
| `majestix.defaultMode` | `"code"` | Default agent mode |
| `majestix.maxContextFiles` | `5` | Max context files per request |
| `majestix.autoApprove` | `"none"` | Auto-approve level: none/readOnly/all |
| `majestix.maxIterations` | `50` | Max agent loop iterations (1-100) |
| `majestix.commandTimeout` | `60` | Shell command timeout in seconds (10-600) |
| `majestix.costWarningThreshold` | `100` | Pause when credits exceed threshold (0=disabled) |
| `majestix.telemetry.enabled` | `true` | Local diagnostics in Output channel |
| `majestix.sessionHistory.enabled` | `true` | Persist conversation history |

## Chat UI Features (Preact webview — `src/webview/`)

- **Agent status bar**: step counter, running cost, elapsed time during agent runs
- **Thinking blocks**: collapsible `<think>` sections from reasoning models
- **API key button**: header icon with green/orange dot, dropdown to view/set/clear key
- **Model selector**: grouped by provider with context window badges
- **Mode selector**: code/architect/ask/askonwrite toggle in header
- **Input history**: Up/Down arrows cycle previous messages (max 30)
- **Slash commands**: `/new`, `/clear`, `/mode`, `/history` with popup menu
- **@-mention file picker**: type `@filename` → debounced fuzzy search → popup
- **Drag-and-drop**: drop files from explorer onto chat, shows overlay
- **File attach button**: native picker, supports multi-select and folders
- **Session drawer**: hamburger icon, date-grouped sessions, search/filter, rename (double-click), delete
- **Retry button**: error cards include retry, re-sends last message
- **Session auto-approve**: "Always allow this session" checkbox on approval cards
- **Escape key**: stops running agent
- **Download chat**: export conversation as Markdown

## Key Design Decisions

- **Extension owns the loop** — backend is a stateless model proxy, extension manages conversation state
- **Preact webview** — UI is a compiled Preact app (dist/webview.js), not inline HTML strings in extension code
- **retainContextWhenHidden: true** — both sidebar panes keep the webview alive when hidden, so the agent keeps running when the user switches tabs
- **File-based sessions** — uses `vscode.workspace.fs` for remote workspace compatibility
- **OS keychain for secrets** — API key never written to settings.json or disk
- **No external telemetry** — telemetry is local-only (Output channel)
- **Path sandboxing** — `path-safety.ts` validates all tool file paths stay within workspace
- **Configurable timeout** — shell commands use `majestix.commandTimeout` setting, not hardcoded
- **Credit awareness** — status bar shows balance, `costWarningThreshold` pauses expensive runs
- **Markdown table normalization** — `markdown.ts` has a 4-pass fixer: split `||` row boundaries, detach inline headers, convert space-aligned tables, fix short separator dashes

## Development

```bash
npm install
npm run build        # esbuild → dist/extension.js + dist/webview.js
npm run watch        # esbuild watch mode
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
```

**Always run all three checks**: `npm run typecheck && npm run lint && npm run build`

### Testing in VSCode
1. Open `inference-vscode/` in VSCode
2. Press F5 → Extension Development Host
3. Extension appears in secondary sidebar
4. Set API key when prompted

### Packaging
```bash
npm run package      # Creates majestix-ai-0.1.0.vsix
code --install-extension majestix-ai-0.1.0.vsix
```
