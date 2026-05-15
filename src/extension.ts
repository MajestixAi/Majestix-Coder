import * as vscode from 'vscode';

import { MajestixClient } from './api/client';
import { ApiKeyManager } from './auth/api-key';
import { registerAskCommand } from './commands/ask';
import { registerExplainCommand } from './commands/explain';
import { registerFixCommand } from './commands/fix';
import { registerGenerateCommand } from './commands/generate';
import {
  registerCommitMessageCommand,
  registerPrDescriptionCommand,
} from './commands/git-assist';
import { registerRefactorCommand } from './commands/refactor';
import { registerReviewCommand } from './commands/review';
import { registerRunTodosCommand } from './commands/run-todos';
import { startTrackingEdits } from './context/active-file';
import { ChatPanelProvider } from './sidebar/chat-panel';
import {
  ensureChatInSecondarySidebar,
  revealChatPanel,
} from './sidebar/reveal';
import { disposeCommandResources } from './tools/execute-command';
import {
  createCreditsStatusBar,
  disposeCreditsStatusBar,
} from './util/credits';
import { disposeTelemetry } from './util/telemetry';

const TELEMETRY_CONSENT_KEY = "majestix.telemetryConsentPrompted";

/**
 * Activates the Majestix AI extension, registers all commands, views, and services.
 *
 * @param context - The VSCode extension context provided by the runtime.
 */
export function activate(context: vscode.ExtensionContext): void {
  void promptTelemetryConsentIfNeeded(context);

  // Core services
  const keyManager = new ApiKeyManager(context.secrets);
  const client = new MajestixClient(keyManager);

  // Set context key for viewsWelcome conditional
  const updateHasApiKey = async (): Promise<void> => {
    const has = await keyManager.hasKey();
    void vscode.commands.executeCommand("setContext", "majestix.hasApiKey", has);
  };
  void updateHasApiKey();
  context.secrets.onDidChange((e) => {
    if (e.key === "majestix.apiKey") {void updateHasApiKey();}
  });

  // Chat panel — registered in all three panes (primary sidebar, bottom panel, secondary sidebar)
  // Each view type gets its OWN ChatPanelProvider instance so state (agent loop, conversation,
  // session, abort controller) is isolated between windows. This prevents a running agent in
  // one window from streaming into another window's sidebar.
  const chatPanelPrimary = new ChatPanelProvider(context.extensionUri, client, context, keyManager);
  const chatPanelSecondary = new ChatPanelProvider(context.extensionUri, client, context, keyManager);
  const retainOpts = { webviewOptions: { retainContextWhenHidden: true } };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatPanelProvider.viewType,
      chatPanelPrimary,
      retainOpts
    ),
    vscode.window.registerWebviewViewProvider(
      "majestix.chatPanelSecondary",
      chatPanelSecondary,
      retainOpts
    )
  );

  // Helper to forward command messages to the primary sidebar webview
  const postToSidebar = (msg: unknown): void => { chatPanelPrimary.postMessage(msg); };

  // Register commands
  context.subscriptions.push(
    registerAskCommand(client, postToSidebar, chatPanelPrimary),
    registerExplainCommand(client, postToSidebar),
    registerRefactorCommand(client, postToSidebar),
    registerFixCommand(client, postToSidebar),
    registerGenerateCommand(client, postToSidebar),
    registerReviewCommand(client, postToSidebar),
    registerRunTodosCommand(client),
    registerCommitMessageCommand(client),
    registerPrDescriptionCommand(client),

    // API key management commands
    vscode.commands.registerCommand("majestix.setApiKey", () =>
      keyManager.promptForKey()
    ),
    vscode.commands.registerCommand("majestix.clearApiKey", async () => {
      await keyManager.clearKey();
      void vscode.window.showInformationMessage("Majestix AI: API key cleared.");
    }),
    vscode.commands.registerCommand("majestix.resetSettings", async () => {
      const confirm = await vscode.window.showWarningMessage(
        "Reset all Majestix AI settings to their defaults?",
        { modal: true },
        "Reset"
      );
      if (confirm !== "Reset") { return; }
      const config = vscode.workspace.getConfiguration("majestix");
      const keys = [
        "apiUrl", "defaultModel", "defaultMode", "maxContextFiles",
        "autoApprove", "maxIterations", "commandTimeout",
        "costWarningThreshold", "requireApprovalAfterCostWarning", "commandWhitelist", "terminalMirror",
        "telemetry.enabled", "sessionHistory.enabled",
      ];
      await Promise.all(
        keys.map((k) => config.update(k, undefined, vscode.ConfigurationTarget.Global))
      );
      void vscode.window.showInformationMessage("Majestix AI: All settings reset to defaults.");
    }),

    // Session management commands
    vscode.commands.registerCommand("majestix.newChat", async () => {
      chatPanelPrimary.postMessage({ type: "session:new" });
      await revealChatPanel();
    }),
    vscode.commands.registerCommand("majestix.sessionHistory", async () => {
      chatPanelPrimary.postMessage({ type: "session:list" });
      await revealChatPanel();
    }),
    // Send terminal output to chat
    vscode.commands.registerCommand("majestix.sendTerminal", async () => {
      const terminal = vscode.window.activeTerminal;
      if (terminal === undefined) {
        const openTerminal = "Open Terminal";
        const choice = await vscode.window.showInformationMessage(
          "Majestix AI: No active terminal. Open one first, then run this command again.",
          openTerminal
        );
        if (choice === openTerminal) {
          await vscode.commands.executeCommand("workbench.action.terminal.new");
        }
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Majestix AI: Reading terminal output…",
          cancellable: false,
        },
        async () => {
          let savedClipboard = "";
          try {
            savedClipboard = await vscode.env.clipboard.readText();

            // Focus the terminal — selectAll only works when the terminal has focus
            terminal.show(false);
            await new Promise(r => setTimeout(r, 150));

            // Clipboard-based extraction (VSCode doesn't expose terminal text directly)
            await vscode.commands.executeCommand("workbench.action.terminal.selectAll");
            await new Promise(r => setTimeout(r, 100));
            await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
            await new Promise(r => setTimeout(r, 100));
            await vscode.commands.executeCommand("workbench.action.terminal.clearSelection");

            const text = await vscode.env.clipboard.readText();

            if (text.trim().length === 0 || text === savedClipboard) {
              void vscode.window.showInformationMessage("Majestix AI: No terminal output to send.");
              return;
            }

            // Truncate if too long — keep truncation notice inside the code fence
            const maxLen = 10_000;
            const trimmed = text.length > maxLen
              ? "[…truncated — showing last 10 KB]\n" + text.slice(text.length - maxLen)
              : text;
            const content = `\`\`\`terminal\n${trimmed}\n\`\`\``;

            chatPanelPrimary.postMessage({
              type: "ask",
              message: `Here is the terminal output. Help me understand or fix any issues:\n\n${content}`,
              rawQuestion: "Terminal output — help me debug",
            });
            await revealChatPanel();
          } catch (err) {
            void vscode.window.showErrorMessage(
              `Majestix AI: Failed to read terminal output — ${err instanceof Error ? err.message : String(err)}`
            );
          } finally {
            // Always restore the original clipboard
            try { await vscode.env.clipboard.writeText(savedClipboard); } catch { /* best effort */ }
          }
        }
      );
    }),

    // Create rules file
    vscode.commands.registerCommand("majestix.createRulesFile", async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (folders === undefined) {
        void vscode.window.showErrorMessage("Majestix AI: No workspace folder open.");
        return;
      }
      const rulesUri = vscode.Uri.joinPath(folders[0].uri, ".majestix-rules");
      try {
        await vscode.workspace.fs.stat(rulesUri);
        // File exists
        const doc = await vscode.workspace.openTextDocument(rulesUri);
        await vscode.window.showTextDocument(doc);
        return;
      } catch { /* doesn't exist, create it */ }

      const template = `# Majestix AI — Project Rules
# These rules are automatically included in the system prompt for every agent session.
# Use them to enforce project conventions, preferred libraries, code style, etc.

# Examples:
# - Always use TypeScript strict mode
# - Prefer functional components with hooks over class components
# - Use pnpm, not npm
# - Test files go in __tests__/ next to the source file
# - Never modify files in the vendor/ directory
`;
      await vscode.workspace.fs.writeFile(rulesUri, new TextEncoder().encode(template));
      const doc = await vscode.workspace.openTextDocument(rulesUri);
      await vscode.window.showTextDocument(doc);
      void vscode.window.showInformationMessage("Majestix AI: Created .majestix-rules — edit to set project conventions.");
    }),

    vscode.commands.registerCommand("majestix.openInTab", () => {
      chatPanelPrimary.openInTab();
    }),

    vscode.commands.registerCommand("majestix.moveToSecondarySidebar", async () => {
      const moved = await ensureChatInSecondarySidebar(context, 6, 350);
      if (!moved) {
        void vscode.window.showInformationMessage(
          "Majestix AI: Could not auto-place in Secondary Side Bar yet. Open the Majestix view once, then run this command again."
        );
      }
    })
  );

  // Track recently edited files for workspace context
  context.subscriptions.push(startTrackingEdits());

  // Status bar credit indicator
  const statusBar = createCreditsStatusBar(client);
  context.subscriptions.push(statusBar);

}

/**
 * Deactivates the extension and disposes long-running services.
 */
export function deactivate(): void {
  disposeCreditsStatusBar();
  disposeCommandResources();
  disposeTelemetry();
}

/**
 * Shows a one-time consent prompt about local telemetry if not previously shown.
 *
 * @param context - The extension context used to persist whether the prompt was shown.
 */
async function promptTelemetryConsentIfNeeded(
  context: vscode.ExtensionContext
): Promise<void> {
  const prompted = context.globalState.get<boolean>(TELEMETRY_CONSENT_KEY, false);
  if (prompted) {
    return;
  }

  const config = vscode.workspace.getConfiguration("majestix");
  const enabled = config.get<boolean>("telemetry.enabled", true);

  const disable = "Disable";
  const keepEnabled = "Keep Enabled";

  if (!enabled) {
    await context.globalState.update(TELEMETRY_CONSENT_KEY, true);
    return;
  }

  const selection = await vscode.window.showInformationMessage(
    "Majestix AI uses local diagnostic telemetry (Output: 'Majestix AI Telemetry'). No telemetry is sent to external services.",
    keepEnabled,
    disable
  );

  if (selection === disable) {
    await config.update("telemetry.enabled", false, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage("Majestix AI: local telemetry disabled.");
  }

  await context.globalState.update(TELEMETRY_CONSENT_KEY, true);
}
