import * as vscode from "vscode";

type PropertyValue = string | number | boolean | undefined | null;

let telemetryChannel: vscode.OutputChannel | undefined;

/**
 * Gets or creates the telemetry output channel.
 *
 * @returns The VSCode output channel used for telemetry.
 */
function getChannel(): vscode.OutputChannel {
  telemetryChannel ??= vscode.window.createOutputChannel("Majestix AI Telemetry");
  return telemetryChannel;
}

/**
 * Removes null and undefined values from a property map.
 *
 * @param properties - The raw property record to sanitize.
 * @returns A new record containing only string, number, or boolean values.
 */
function sanitizeProperties(
  properties: Record<string, PropertyValue>
): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null) {continue;}
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
    }
  }
  return safe;
}

/**
 * Checks whether telemetry is enabled in workspace settings.
 *
 * @returns True if telemetry is enabled, false otherwise.
 */
function isTelemetryEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("majestix")
    .get<boolean>("telemetry.enabled", true);
}

/**
 * Records a named telemetry event with optional properties to the output channel.
 *
 * @param name - The name of the event to track.
 * @param properties - Optional key-value properties to attach to the event.
 */
export function trackEvent(
  name: string,
  properties: Record<string, PropertyValue> = {}
): void {
  if (!isTelemetryEnabled()) {
    return;
  }

  const payload = {
    timestamp: new Date().toISOString(),
    event: name,
    properties: sanitizeProperties(properties),
  };

  getChannel().appendLine(JSON.stringify(payload));
}

/**
 * Disposes the telemetry output channel and clears the reference.
 */
export function disposeTelemetry(): void {
  telemetryChannel?.dispose();
  telemetryChannel = undefined;
}
