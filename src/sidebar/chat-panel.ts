import * as vscode from "vscode";
import * as path from "path";

import { runAgentLoop } from "../agent/loop";
import {
  type Message,
  MajestixClient,
  ModelInfo,
} from "../api/client";
import { ApiKeyManager } from "../auth/api-key";
import { getActiveFileContext, getWorkspaceDiagnostics } from "../context/active-file";
import { generateSessionTitle, SessionStore } from "../sessions/session-store";

import { triggerCreditRefresh } from "../util/credits";
import { resolveWorkspacePath } from "../util/path-safety";
import { trackEvent } from "../util/telemetry";

/** Typed union of messages that the webview can post to the extension. */
interface WebviewMessage {
  type: string;
  message?: string;
  model?: string;
  attachedFiles?: { path: string; name: string }[];
  mode?: string;
  approved?: boolean;
  names?: string[];
  uris?: string[];
  id?: string;
  toolName?: string;
  content?: string;
  title?: string;
  query?: string;
  path?: string;
  enabled?: boolean;
  filePath?: string;
  newContent?: string;
}

/**
 * WebviewViewProvider for the Majestix AI chat sidebar panel.
 * Handles agent loop execution, session management, file attachments, and webview messaging.
 */
export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "majestix.chatPanel";

  private _views = new Map<string, vscode.WebviewView>();
  private _tabPanel?: vscode.WebviewPanel;
  private _models: ModelInfo[] = [];
  private _abortController: AbortController | null = null;
  /** Tracks the running agent loop so new messages can queue behind it. */
  private _currentAgentPromise: Promise<void> | null = null;
  private _mode: string = vscode.workspace.getConfiguration("majestix").get<string>("defaultMode", "code");
  private _enableThinking = true;
  private _pendingApproval: {
    resolve: (approved: boolean) => void;
    toolName: string;
    filePath?: string;
    newContent?: string;
  } | null = null;

  // Session persistence
  private _sessionStore: SessionStore | null = null;
  private _activeSessionId: string | null = null;
  private _activeConversation: Message[] = [];
  private _activeCompactSummary: string | null = null;

  /**
   * Creates a ChatPanelProvider for the Majestix sidebar panel.
   *
   * @param _extensionUri - The URI of the extension directory, used to resolve webview resources.
   * @param _client - The Majestix API client used for model and streaming requests.
   * @param _context - The VSCode extension context for state persistence and secret storage.
   * @param _keyManager - Optional API key manager for key status and prompt operations.
   */
  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _client: MajestixClient,
    private readonly _context: vscode.ExtensionContext,
    private readonly _keyManager?: ApiKeyManager
  ) {
    // Always start fresh — don't restore last session on launch
    void this._context.workspaceState.update("majestix.activeSessionId", undefined);
  }

  /**
   * Called by VSCode to initialize the webview view with HTML content and message handlers.
   *
   * @param webviewView - The webview view instance provided by the VSCode runtime.
   * @param _context - The webview view resolve context (unused).
   * @param _token - A cancellation token (unused).
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    const viewId = webviewView.viewType;
    this._views.set(viewId, webviewView);

    webviewView.onDidDispose(() => { this._views.delete(viewId); });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (rawMsg: unknown) => {
      await this._handleWebviewMessage(rawMsg as WebviewMessage);
    });

    void this._loadModels();
    void this._handleSessionList();
  }

  /**
   * Posts a message to the webview panel if it is visible.
   *
   * @param msg - The message object to post to the webview.
   */
  public postMessage(msg: unknown): void {
    for (const view of this._views.values()) {
      try {
        void view.webview.postMessage(msg);
      } catch {
        // Webview disposed but still in _views — ignore, cleanup happens in onDidDispose
      }
    }
    if (this._tabPanel) {
      try {
        void this._tabPanel.webview.postMessage(msg);
      } catch {
        // Tab panel disposed but reference not yet cleared — ignore
      }
    }
  }

  /** Focus the chat input textarea in the webview. */
  public focusInput(): void {
    for (const view of this._views.values()) {
      void view.webview.postMessage({ type: "focusInput" });
      view.show(true);
    }
    if (this._tabPanel) {
      void this._tabPanel.webview.postMessage({ type: "focusInput" });
      this._tabPanel.reveal(vscode.ViewColumn.Active);
    }
  }

  /**
   * Opens the chat in an editor tab (center pane), like Kilo Code's "Open in New Tab".
   */
  public openInTab(): void {
    if (this._tabPanel) {
      this._tabPanel.reveal(vscode.ViewColumn.One);
      return;
    }

    this._tabPanel = vscode.window.createWebviewPanel(
      "majestix.chatTab",
      "Majestix AI",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._extensionUri],
      }
    );

    this._tabPanel.iconPath = {
      light: vscode.Uri.joinPath(this._extensionUri, "resources", "icon.svg"),
      dark: vscode.Uri.joinPath(this._extensionUri, "resources", "icon.svg"),
    };

    this._tabPanel.webview.html = this._getHtmlForWebview(this._tabPanel.webview);

    this._tabPanel.webview.onDidReceiveMessage(async (rawMsg: unknown) => {
      const msg = rawMsg as WebviewMessage;
      await this._handleWebviewMessage(msg);
    });

    this._tabPanel.onDidDispose(() => { this._tabPanel = undefined; });
  }

  /**
   * Handle the "View Diff" button click in the approval card.
   * Opens a diff editor comparing the current file state with the backup.
   *
   * @param _toolName - The name of the tool that requested approval.
   */
  private async _handleViewDiff(_toolName: string): Promise<void> {
    if (this._pendingApproval?.filePath === undefined) {
      void vscode.window.showInformationMessage("No file diff available.");
      return;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined) { return; }

    const filePath = this._pendingApproval.filePath;
    let currentUri: vscode.Uri;
    try {
      currentUri = resolveWorkspacePath(folders[0].uri, filePath);
    } catch {
      void vscode.window.showErrorMessage(`Could not resolve path for diff: ${filePath}`);
      return;
    }

    // Look for a matching backup in the same directory with .majestix-backup extension
    const backupUri = vscode.Uri.joinPath(
      vscode.Uri.joinPath(currentUri, ".."),
      `${filePath.split("/").pop() ?? "backup"}.majestix-backup`
    );

    try {
      await vscode.workspace.fs.stat(backupUri);
      await vscode.commands.executeCommand(
        "vscode.diff",
        backupUri,
        currentUri,
        `Majestix: ${filePath} (backup ↔ current)`
      );
    } catch {
      // No backup found — show a simple diff of the pending new content
      if (this._pendingApproval.newContent !== undefined) {
        // leftUri placeholder
        // rightUri placeholder
        void vscode.window.showInformationMessage(
          `Diff not available for ${filePath} — backup was not created yet.`
        );
      } else {
        void vscode.window.showInformationMessage(
          `Diff not available for ${filePath} — no backup or pending content found.`
        );
      }
    }
  }

  /**
   * Handles a message received from any webview pane (sidebar, secondary sidebar, or editor tab).
   *
   * @param msg - The parsed webview message.
   */
  private async _handleWebviewMessage(msg: WebviewMessage): Promise<void> {
    // "stop" fires immediately — it MUST NOT be queued behind _currentAgentPromise.
    // Check synchronously before any async/await that might block.
    if (msg.type === "stop") {
      this._abortController?.abort();
      return;
    }

    // "sendAgent" queues behind any running agent loop so new messages append
    // to the conversation rather than replacing it. The running loop will finish
    // (aborted or completed) and persist its partial conversation, then the new
    // loop starts with the complete context.
    if (msg.type === "sendAgent") {
      if (msg.mode !== undefined && msg.mode.length > 0) {
        this._mode = msg.mode;
      }
      await this._currentAgentPromise;
      const promise = this._handleAgentSend(msg.message ?? "", msg.model, msg.attachedFiles);
      this._currentAgentPromise = promise;
      try {
        await promise;
      } finally {
        // Only null if we still own the promise — prevents a concurrent
        // message's run from being clobbered if it started while we were
        // in the await above.
        if (this._currentAgentPromise === promise) {
          this._currentAgentPromise = null;
        }
      }
      return;
    }


    switch (msg.type) {
      case "loadModels":
        await this._loadModels();
        break;
      case "newChat":
      case "session:new":
        this._handleSessionNew();
        break;
      case "setMode":
        this._mode = msg.mode ?? "code";
        break;
      case "setThinking":
        this._enableThinking = msg.enabled === true;
        break;
      case "approvalResponse":
        if (this._pendingApproval !== null) {
          trackEvent("approval.decision", {
            tool: this._pendingApproval.toolName,
            approved: msg.approved === true,
          });
          this._pendingApproval.resolve(msg.approved === true);
          this._pendingApproval = null;
        }
        break;
      case "pickFiles":
        await this._handlePickFiles();
        break;
      case "dropFiles":
        await this._handleDroppedFileNames(msg.names ?? []);
        break;
      case "dropUris":
        await this._handleDroppedUris(msg.uris ?? []);
        break;
      case "session:list":
        await this._handleSessionList();
        break;
      case "session:load":
        await this._handleSessionLoad(msg.id ?? "");
        break;
      case "session:delete":
        await this._handleSessionDelete(msg.id ?? "");
        break;
      case "session:deleteAll":
        await this._handleSessionDeleteAll();
        break;
      case "downloadChat":
        await this._handleDownloadChat(msg.content ?? "");
        break;
      case "session:rename":
        await this._handleSessionRename(msg.id ?? "", msg.title ?? "");
        break;
      case "searchFiles":
        await this._handleFileSearch(msg.query ?? "");
        break;
      case "pickFileByPath":
        await this._handlePickFileByPath(msg.path ?? "");
        break;
      case "copyToClipboard":
        await vscode.env.clipboard.writeText(msg.content ?? "");
        break;
      case "pastePath":
        await this._handlePastePath(msg.path ?? "");
        break;
      case "viewDiff":
        await this._handleViewDiff(msg.toolName ?? "");
        break;
      case "openSettings":
        void vscode.commands.executeCommand("workbench.action.openGlobalSettings");
        break;
      case "keyStatus":
        await this._handleKeyStatus();
        break;
      case "keySet":
        if (this._keyManager !== undefined) {
          await this._keyManager.promptForKey();
          await this._handleKeyStatus();
        }
        break;
      case "keyClear":
        if (this._keyManager !== undefined) {
          await this._keyManager.clearKey();
          void vscode.window.showInformationMessage("Majestix AI: API key cleared.");
          await this._handleKeyStatus();
        }
        break;
    }
  }

  /**
   * Broadcast a message to all resolved webview panes.
   *
   * @param msg - The message object to broadcast.
   */
  private _broadcast(msg: unknown): void {
    for (const view of this._views.values()) {
      try {
        void view.webview.postMessage(msg);
      } catch {
        // Webview disposed but still in _views — ignore, cleanup happens in onDidDispose
      }
    }
    if (this._tabPanel) {
      try {
        void this._tabPanel.webview.postMessage(msg);
      } catch {
        // Tab panel disposed but reference not yet cleared — ignore
      }
    }
  }

  // ── Private helpers ──────────────────────────────────────────

  /**
   * Lazy-init session store from first workspace folder.
   *
   * @returns The session store instance, or null if no workspace folder is open.
   */
  private _getSessionStore(): SessionStore | null {
    if (this._sessionStore !== null) {return this._sessionStore;}
    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined) {return null;}
    this._sessionStore = new SessionStore(folders[0].uri);
    return this._sessionStore;
  }

  /**
   * Persists the active session ID in workspace state.
   *
   * @param id - The session ID to set as active, or null to clear.
   */
  private _setActiveSessionId(id: string | null): void {
    this._activeSessionId = id;
    void this._context.workspaceState.update("majestix.activeSessionId", id);
  }

  /**
   * Fetches available models from the API and posts them to the webview.
   */
  private async _loadModels(): Promise<void> {
    try {
      const data = await this._client.getModels();
      this._models = data.models;
      this._broadcast({
        type: "models",
        models: this._models,
      });
    } catch (err: unknown) {
      this._broadcast({
        type: "error",
        message: `Failed to load models: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Open a file picker and send the selected file contents back to the webview.
   */
  private async _handlePickFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFolders: true,
      openLabel: "Attach",
      filters: { "All Files": ["*"] },
    });

    if (uris === undefined || uris.length === 0) {return;}

    const config = vscode.workspace.getConfiguration("majestix");
    const maxContextFiles = Math.max(1, config.get<number>("maxContextFiles", 5));
    const selectedUris = uris.slice(0, maxContextFiles);
    if (uris.length > maxContextFiles) {
      void vscode.window.showWarningMessage(
        `Only the first ${String(maxContextFiles)} files were attached (majestix.maxContextFiles).`
      );
    }

    const files: { path: string; name: string; content: string }[] = [];
    for (const uri of selectedUris) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        const relPath = vscode.workspace.asRelativePath(uri);
        const name = uri.path.split("/").pop() ?? relPath;

        if (stat.type === vscode.FileType.Directory) {
          // For folders, provide a listing of contents
          const children = await vscode.workspace.fs.readDirectory(uri);
          const listing = children
            .slice(0, 50)
            .map(([n, type]) => type === vscode.FileType.Directory ? `${n}/` : n)
            .join("\n");
          files.push({
            path: relPath,
            name,
            content: `[Directory listing: ${relPath}]\n${listing}${children.length > 50 ? "\n... (truncated)" : ""}`,
          });
        } else {
          const bytes = await vscode.workspace.fs.readFile(uri);
          let content = new TextDecoder().decode(bytes);
          if (content.length > 100_000) {
            content = content.slice(0, 100_000) + "\n[truncated at 100KB]";
          }
          files.push({ path: relPath, name, content });
        }
      } catch {
        // skip unreadable files
      }
    }

    if (files.length > 0) {
      this._broadcast({ type: "filesAttached", files });
    }
  }

  /**
   * Queries the API key manager and sends the current key status to the webview.
   */
  private async _handleKeyStatus(): Promise<void> {
    if (this._keyManager === undefined) {return;}
    const hasKey = await this._keyManager.hasKey();
    let maskedKey = "";
    if (hasKey) {
      const key = await this._keyManager.getKey();
      if (key !== undefined && key.length > 0) {maskedKey = key.slice(0, 7) + "..." + key.slice(-4);}
    }
    this.postMessage({ type: "keyStatus", hasKey, maskedKey });
  }

  /**
   * Attach a single file by its workspace-relative path (from @-mention picker).
   *
   * @param filePath - The workspace-relative path of the file to attach.
   */
  private async _handlePickFileByPath(filePath: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined) { return; }
    try {
      const uri = resolveWorkspacePath(folders[0].uri, filePath);
      const stat = await vscode.workspace.fs.stat(uri);
      const relativePath = vscode.workspace.asRelativePath(uri, false);

      let name: string;
      let content: string;

      if (stat.type === vscode.FileType.Directory) {
        const children = await vscode.workspace.fs.readDirectory(uri);
        const listing = children
          .slice(0, 50)
          .map(([n, type]) => type === vscode.FileType.Directory ? `${n}/` : n)
          .join("\n");
        name = relativePath.split("/").pop() ?? relativePath;
        content = `[Directory listing: ${relativePath}]\n${listing}`;
      } else {
        const bytes = await vscode.workspace.fs.readFile(uri);
        content = new TextDecoder().decode(bytes);
        if (content.length > 100_000) {
          content = content.slice(0, 100_000) + "\n[truncated at 100KB]";
        }
        name = relativePath.split("/").pop() ?? relativePath;
      }

      this._broadcast({
        type: "filesAttached",
        files: [{ path: relativePath, name, content }],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._broadcast({
        type: "error",
        message: `Could not attach file: ${msg}`,
      });
    }
  }

  /**
   * Called when the webview posts a `pastePath` message (user pasted text into the input).
   * Detects whether the pasted string looks like a file path and, if so, tries to attach it.
   * All path detection logic lives here in the extension host to avoid template-literal escaping
   * hazards in the embedded webview JavaScript.
   *
   * @param pasted - The raw trimmed text that was pasted into the chat input.
   */
  private async _handlePastePath(pasted: string): Promise<void> {
    const trimmed = pasted.trim();
    if (trimmed.length < 2 || trimmed.length > 512 || trimmed.includes("\n")) { return; }

    const isUnixAbsolute = trimmed.startsWith("/");
    const isRelative = trimmed.startsWith("./") || trimmed.startsWith("../");
    const isWinAbsolute = trimmed.length >= 3 && trimmed.charAt(1) === ":" &&
      (trimmed.charAt(2) === "/" || trimmed.charAt(2) === "\\");

    if (!isUnixAbsolute && !isRelative && !isWinAbsolute) { return; }

    await this._handlePickFileByPath(trimmed);
    // Tell the webview to clear the raw path text from the input and replace with a chip
    this._broadcast({ type: "clearPastedPath", path: trimmed });
  }

  /**
   * Search workspace files by name fragment (for @-mention picker).
   *
   * @param query - The search query string to match against file names.
   */
  private async _handleFileSearch(query: string): Promise<void> {
    if (query.length < 2) {
      this.postMessage({ type: "fileSearchResults", files: [] });
      return;
    }
    try {
      const pattern = `**/*${query}*`;
      const found = await vscode.workspace.findFiles(pattern, "**/node_modules/**", 10);
      const results = found.map(uri => ({
        path: vscode.workspace.asRelativePath(uri),
        name: uri.path.split("/").pop() ?? "",
      }));
      this.postMessage({ type: "fileSearchResults", files: results });
    } catch {
      this.postMessage({ type: "fileSearchResults", files: [] });
    }
  }

  /**
   * Handle files dropped by name — search workspace for matching files.
   *
   * @param names - The array of file names dropped onto the chat panel.
   */
  private async _handleDroppedFileNames(names: string[]): Promise<void> {
    if (names.length === 0) {return;}
    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined) {return;}

    const files: { path: string; name: string; content: string }[] = [];
    const config = vscode.workspace.getConfiguration("majestix");
    const maxContextFiles = Math.max(1, config.get<number>("maxContextFiles", 5));

    for (const rawName of names.slice(0, maxContextFiles)) {
      // Use basename so path separators from absolute drops don't break the glob
      const name = path.basename(rawName);
      if (name.length === 0) { continue; }

      // Try to find the file in workspace by name
      const found = await vscode.workspace.findFiles(`**/${name}`, "**/node_modules/**", 1);
      if (found.length > 0) {
        try {
          const bytes = await vscode.workspace.fs.readFile(found[0]);
          let content = new TextDecoder().decode(bytes);
          if (content.length > 100_000) {
            content = content.slice(0, 100_000) + "\n[truncated at 100KB]";
          }
          const relPath = vscode.workspace.asRelativePath(found[0]);
          files.push({ path: relPath, name, content });
        } catch { /* skip */ }
      }
    }

    if (files.length > 0) {
      this._broadcast({ type: "filesAttached", files });
    }
  }

  /**
   * Handle URI drops (from VSCode explorer tree).
   *
   * @param uris - The array of URI strings dropped onto the chat panel.
   */
  private async _handleDroppedUris(uris: string[]): Promise<void> {
    if (uris.length === 0) {return;}

    const files: { path: string; name: string; content: string }[] = [];
    const config = vscode.workspace.getConfiguration("majestix");
    const maxContextFiles = Math.max(1, config.get<number>("maxContextFiles", 5));

    for (const uriStr of uris.slice(0, maxContextFiles)) {
      try {
        const uri = vscode.Uri.parse(uriStr);
        const stat = await vscode.workspace.fs.stat(uri);

        if (stat.type === vscode.FileType.Directory) {
          // For directories, list top-level files and attach a summary
          const children = await vscode.workspace.fs.readDirectory(uri);
          const relPath = vscode.workspace.asRelativePath(uri);
          const listing = children
            .slice(0, 50)
            .map(([name, type]) => type === vscode.FileType.Directory ? `${name}/` : name)
            .join("\n");
          files.push({
            path: relPath,
            name: relPath.split("/").pop() ?? relPath,
            content: `[Directory listing: ${relPath}]\n${listing}`,
          });
        } else {
          const bytes = await vscode.workspace.fs.readFile(uri);
          let content = new TextDecoder().decode(bytes);
          if (content.length > 100_000) {
            content = content.slice(0, 100_000) + "\n[truncated at 100KB]";
          }
          const relPath = vscode.workspace.asRelativePath(uri);
          const name = uri.path.split("/").pop() ?? relPath;
          files.push({ path: relPath, name, content });
        }
      } catch { /* skip */ }
    }

    if (files.length > 0) {
      this._broadcast({ type: "filesAttached", files });
    }
  }

  /**
   * Saves the current chat conversation to a Markdown file on disk.
   *
   * @param content - The markdown-formatted chat content to write to the file.
   */
  private async _handleDownloadChat(content: string): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`majestix-chat-${new Date().toISOString().slice(0, 10)}.md`),
      filters: { Markdown: ["md"], "All Files": ["*"] },
    });
    if (uri === undefined) {return;}
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    void vscode.window.showInformationMessage(`Chat saved to ${uri.fsPath}`);
  }

  // ── Session management ───────────────────────────────────────

  /**
   * Loads the session list from the store and sends it to the webview.
   */
  private async _handleSessionList(): Promise<void> {
    const store = this._getSessionStore();
    if (store === null) {return;}
    const sessions = await store.list();
    this.postMessage({ type: "session:list", sessions });
  }

  /**
   * Loads a session by ID and sends its data to the webview.
   *
   * @param id - The unique ID of the session to load.
   */
  private async _handleSessionLoad(id: string): Promise<void> {
    const store = this._getSessionStore();
    if (store === null) {return;}
    const session = await store.get(id);
    if (session === null) {
      this.postMessage({ type: "session:error", message: "Session not found" });
      return;
    }
    this._setActiveSessionId(session.id);
    this._activeConversation = session.messages;
    this._activeCompactSummary = session.compact_summary ?? null;
    this._mode = session.mode.length > 0 ? session.mode : "code";
    this.postMessage({ type: "session:loaded", session });
    this.postMessage({ type: "session:active", id: session.id });
  }

  /**
   * Deletes a session by ID and refreshes the session list in the webview.
   *
   * @param id - The unique ID of the session to delete.
   */
  private async _handleSessionDelete(id: string): Promise<void> {
    const store = this._getSessionStore();
    if (store === null) {return;}
    await store.delete(id);
    if (this._activeSessionId === id) {
      this._setActiveSessionId(null);
      this._activeConversation = [];
      this._activeCompactSummary = null;
    }
    this.postMessage({ type: "session:deleted", id });
    await this._handleSessionList();
  }

  /**
   * Deletes all sessions and clears the active session state.
   */
  private async _handleSessionDeleteAll(): Promise<void> {
    const store = this._getSessionStore();
    if (store === null) {return;}
    await store.deleteAll();
    this._setActiveSessionId(null);
    this._activeConversation = [];
    this._activeCompactSummary = null;
    this.postMessage({ type: "session:list", sessions: [] });
    this.postMessage({ type: "session:active", id: null });
  }

  /**
   * Renames a session and refreshes the session list in the webview.
   *
   * @param id - The unique ID of the session to rename.
   * @param title - The new title for the session.
   */
  private async _handleSessionRename(id: string, title: string): Promise<void> {
    const store = this._getSessionStore();
    if (store === null) {return;}
    const session = await store.get(id);
    if (session === null) {return;}
    session.title = title;
    await store.update(session);
    await this._handleSessionList();
  }

  /**
   * Clears the active session and notifies the webview to start a new chat.
   */
  private _handleSessionNew(): void {
    this._setActiveSessionId(null);
    this._activeConversation = [];
    this._activeCompactSummary = null;
    this.postMessage({ type: "session:active", id: null });
  }

  /**
   * Persists the current conversation to the session store, creating a new session if needed.
   *
   * @param rawUserMessage - The original user message text used to generate a title for new sessions.
   * @param model - The model key used for this conversation.
   * @param conversation - The full conversation messages array to save.
   * @param compactSummary - The rolling compact summary from the agent loop, or null if none.
   */
  private async _persistSession(
    rawUserMessage: string,
    model: string,
    conversation: Message[],
    compactSummary: string | null,
  ): Promise<void> {
    const store = this._getSessionStore();
    if (store === null) {return;}

    try {
      if (this._activeSessionId !== null) {
        // Update existing session
        const existing = await store.get(this._activeSessionId);
        if (existing !== null) {
          existing.messages = conversation;
          existing.model = model;
          if (compactSummary !== null) { existing.compact_summary = compactSummary; }
          await store.update(existing);
          this._activeConversation = conversation;
          this._activeCompactSummary = compactSummary;
        }
      } else {
        // Create new session
        const title = generateSessionTitle(rawUserMessage);
        const session = await store.create({
          title,
          mode: this._mode,
          model,
          messages: conversation,
          ...(compactSummary !== null ? { compact_summary: compactSummary } : {}),
        });
        this._setActiveSessionId(session.id);
        this._activeConversation = conversation;
        this._activeCompactSummary = compactSummary;
        this.postMessage({ type: "session:active", id: session.id });
      }
      await this._handleSessionList();
    } catch (err: unknown) {
      console.error("Failed to persist session:", err);
      this._broadcast({
        type: "error",
        message: `Failed to save session: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Agent mode — runs the agentic tool-use loop via /code endpoint.
   *
   * @param message - The raw user message to send to the agent.
   * @param model - Optional model key to use; falls back to the configured default.
   * @param attachedFiles - Optional array of file path/name objects to include as context.
   */
  private async _handleAgentSend(
    message: string,
    model?: string,
    attachedFiles?: { path: string; name: string }[]
  ): Promise<void> {
    this._abortController = new AbortController();

    const config = vscode.workspace.getConfiguration("majestix");
    const defaultModel = config.get<string>("defaultModel", "");
    const maxContextFiles = Math.max(1, config.get<number>("maxContextFiles", 5));
    const modelArg = (model !== undefined && model.length > 0) ? model : (defaultModel.length > 0 ? defaultModel : undefined);
    const selectedModel = modelArg;

    const parts: string[] = [message];

    // Inject active file metadata (path + language) so the agent knows what file is open.
    // Do NOT inject file content — the agent reads files via read_file when needed.
    // Injecting full file content bloats every message by 30-50KB and causes
    // the model to act on potentially stale file state.
    const fileCtx = getActiveFileContext();
    if (fileCtx !== null) {
      parts.push(`\n\n<active_file path="${fileCtx.filePath}" language="${fileCtx.language}" />`);
      // Only inject selected text — it's what the user explicitly highlighted
      if (fileCtx.selection !== undefined) {
        parts.push(`\n<selection lines="${String(fileCtx.selection.start)}-${String(fileCtx.selection.end)}">`);
        parts.push(fileCtx.selection.text);
        parts.push("</selection>");
      }
      if (fileCtx.diagnostics.length > 0) {
        parts.push("\n<diagnostics>");
        for (const d of fileCtx.diagnostics) {
          parts.push(`  Line ${String(d.line)} [${d.severity}]: ${d.message}`);
        }
        parts.push("</diagnostics>");
      }
    }

    // Include workspace-wide diagnostics (errors/warnings from Problems panel)
    const wsDiags = getWorkspaceDiagnostics();
    if (wsDiags.length > 0) {
      parts.push("\n<workspace_diagnostics>");
      for (const d of wsDiags) {
        parts.push(`  ${d.filePath}:${String(d.line)} [${d.severity}]: ${d.message}`);
      }
      parts.push("</workspace_diagnostics>");
    }

    // Read and attach user-selected files
    if (attachedFiles !== undefined && attachedFiles.length > 0) {
      const selectedFiles = attachedFiles.slice(0, maxContextFiles);
      if (attachedFiles.length > maxContextFiles) {
        this._broadcast({
          type: "error",
          message: `Only the first ${String(maxContextFiles)} attached files were included (majestix.maxContextFiles).`,
        });
      }

      for (const f of selectedFiles) {
        try {
          const folders = vscode.workspace.workspaceFolders;
          const root = folders?.[0]?.uri ?? null;
          if (root === null) {
            throw new Error("No workspace folder open");
          }

          const fileUri = resolveWorkspacePath(root, f.path);
          const bytes = await vscode.workspace.fs.readFile(fileUri);
          let content = new TextDecoder().decode(bytes);
          if (content.length > 100_000) {
            content = content.slice(0, 100_000) + "\n[truncated at 100KB]";
          }
          parts.push(`\n<attached_file path="${f.path}">`);
          parts.push(content);
          parts.push("</attached_file>");
        } catch {
          parts.push(`\n<attached_file path="${f.path}">[error: could not read file]</attached_file>`);
        }
      }
    }

    const enrichedMessage = parts.join("\n");

    const postMessage = (msg: unknown): void => { this.postMessage(msg); };

    const requestApproval = (
      toolName: string,
      description: string,
      detail?: string,
      filePath?: string,
      newContent?: string,
    ): Promise<boolean> => {
      return new Promise((resolve) => {
        trackEvent("approval.requested", { tool: toolName });
        this._pendingApproval = { resolve, toolName, filePath, newContent };
        this._broadcast({
          type: "approval_request",
          toolName,
          description,
          detail: detail ?? undefined,
          filePath,
        });
      });
    };

    // Build context window map from pre-loaded models — avoids a getModels() round-trip per message
    const cachedModelContextWindows = new Map<string, number>();
    for (const m of this._models) {
      if (m.context_window > 0) {
        cachedModelContextWindows.set(m.key, m.context_window);
      }
    }

    try {
      for await (const event of runAgentLoop(enrichedMessage, {
        mode: this._mode,
        model: selectedModel,
        client: this._client,
        postMessage,
        requestApproval,
        signal: this._abortController.signal,
        initialMessages: this._activeConversation.length > 0
          ? this._activeConversation
          : undefined,
        cachedModelContextWindows,
        enableThinking: this._enableThinking,
        compactSummary: this._activeCompactSummary,
      })) {
        // Forward all agent events to the webview
        this._broadcast(event);

        if (event.type === "done") {
          triggerCreditRefresh(this._client);
          // Persist the conversation (includes partial turn from aborted runs).
          // The conversation from the 'done' event is the complete state —
          // whether the loop completed normally, was aborted mid-stream,
          // or hit an error. This ensures _activeConversation is always up
          // to date so the next sendAgent can build on it.
          await this._persistSession(message, selectedModel ?? "", event.conversation, event.compact_summary);
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        this._broadcast({ type: "stopped" });
      } else {
        this._broadcast({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      this._abortController = null;
      this._pendingApproval = null;
    }
  }

  /**
   * Generates the HTML content for the webview panel.
   * Loads the Preact component bundle (dist/webview.js) and the markdown renderer (dist/webview-markdown.js).
   *
   * @param webview - The webview instance used to resolve resource URIs and CSP sources.
   * @returns An HTML string to set as the webview's content.
   */
  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "resources", "majestix-logo.png")
    ).toString();
    const markdownScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "dist", "webview-markdown.js")
    ).toString();
    const webviewScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "dist", "webview.js")
    ).toString();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <script nonce="${nonce}" src="${markdownScriptUri}"></script>
</head>
<body>
  <div id="root" data-logo-uri="${logoUri}"></div>
  <script nonce="${nonce}" src="${webviewScriptUri}"></script>
</body>
</html>`;
  }
}

// ── UI code moved to src/webview/ (Preact components) ──


/**
 * Generates a random 32-character nonce string for use in Content Security Policy headers.
 *
 * @returns A random alphanumeric nonce string.
 */
function getNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
