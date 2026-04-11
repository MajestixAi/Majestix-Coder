import * as vscode from "vscode";
import { MajestixClient } from "../api/client";

let statusBarItem: vscode.StatusBarItem;
let refreshInterval: ReturnType<typeof setInterval> | undefined;

/**
 * Creates and shows the credits status bar item, starting a 60-second refresh cycle.
 *
 * @param client - The Majestix API client used to fetch usage data.
 * @returns The VSCode status bar item displaying the current credit balance.
 */
export function createCreditsStatusBar(
  client: MajestixClient
): vscode.StatusBarItem {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "majestix.ask";
  statusBarItem.tooltip = "Majestix AI — Click to Ask AI";
  statusBarItem.text = "$(sparkle) Majestix";
  statusBarItem.show();

  // Refresh credits every 60 seconds
  void refreshCredits(client);
  refreshInterval = setInterval(() => { void refreshCredits(client); }, 60_000);

  return statusBarItem;
}

/**
 * Stops the refresh interval and disposes the credits status bar item.
 */
export function disposeCreditsStatusBar(): void {
  if (refreshInterval !== undefined) {
    clearInterval(refreshInterval);
    refreshInterval = undefined;
  }
  statusBarItem.dispose();
}

/**
 * Fetches the current usage from the API and updates the status bar text.
 *
 * @param client - The Majestix API client used to retrieve usage data.
 */
async function refreshCredits(client: MajestixClient): Promise<void> {
  try {
    const usage = await client.getUsage();
    const remaining = Math.round(
      usage.plan_credits_remaining + usage.topup_balance
    );
    statusBarItem.text = `$(sparkle) ${String(remaining)} credits`;
    statusBarItem.tooltip = `Majestix AI — ${usage.plan} plan\n${String(remaining)} credits remaining\nClick to Ask AI`;
  } catch {
    // Not logged in or API error — show warning state so user knows the balance is stale
    statusBarItem.text = "$(warning) Majestix";
    statusBarItem.tooltip = "Majestix AI — Could not load balance. Click to set up or check your API key.";
  }
}

/**
 * Immediately triggers a credit balance refresh outside of the normal 60-second cycle.
 * 
 * @param client - The Majestix API client used to retrieve updated usage data.
 * 
 * @remarks
 * This function forces an immediate update of the credit balance displayed in the
 * Majestix status bar, bypassing the scheduled 60‑second refresh interval. It is
 * useful when the user wants to see the latest credit status right after
 * authentication, after a plan change, or when the balance might be stale (e.g.,
 * after a top‑up or usage that affects the credit count). Call this function when
 * you need to refresh the displayed credit count on demand rather than waiting
 * for the automatic interval.
 */
export function triggerCreditRefresh(client: MajestixClient): void {
  void refreshCredits(client);
}
