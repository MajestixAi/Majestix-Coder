import * as vscode from "vscode";

const MOVED_KEY = "majestix.viewMovedToAuxBar";

/**
 * Attempts to move the currently focused view to the secondary sidebar (auxiliary bar).
 *
 * @returns True if the move command succeeded, false otherwise.
 */
async function tryMoveFocusedViewToSecondarySidebar(): Promise<boolean> {
  try {
    await vscode.commands.executeCommand("workbench.action.moveViewToAuxiliaryBar");
    return true;
  } catch {
    return false;
  }
}

/**
 * Focuses the Majestix chat panel in the sidebar.
 */
export async function revealChatPanel(): Promise<void> {
  await vscode.commands.executeCommand("majestix.chatPanel.focus");
}

/**
 * Attempts to place the Majestix chat panel in the secondary sidebar if not already done.
 * Retries several times with a delay to allow the view to initialize.
 *
 * @param context - The extension context used to persist whether the move already happened.
 * @param attempts - The maximum number of move attempts before giving up.
 * @param delayMs - The delay in milliseconds between attempts.
 * @returns True if the panel was successfully moved or was already in the secondary sidebar.
 */
export async function ensureChatInSecondarySidebar(
  context: vscode.ExtensionContext,
  attempts = 4,
  delayMs = 350
): Promise<boolean> {
  const alreadyMoved = context.globalState.get<boolean>(MOVED_KEY, false);
  if (alreadyMoved) {
    return true;
  }

  for (let index = 0; index < attempts; index++) {
    await vscode.commands.executeCommand("majestix.chatPanel.focus");

    const moved = await tryMoveFocusedViewToSecondarySidebar();
    if (moved) {
      await context.globalState.update(MOVED_KEY, true);
      try {
        await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
      } catch {
        // Command not available on older builds; ignore.
      }
      return true;
    }

    if (index < attempts - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return false;
}
