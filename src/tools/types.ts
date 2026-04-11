import * as vscode from "vscode";
import type { ToolDefinition } from "../api/client";

/**
 * Result of executing a tool — sent back to the LLM as a tool_result content block.
 */
export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * Context passed to every tool execution.
 */
export interface ToolContext {
  workspaceRoot: vscode.Uri;
  /** Post a message to the webview for UI updates */
  postMessage: (msg: unknown) => void;
  /** Request user approval (returns true if approved) */
  requestApproval: (toolName: string, description: string, detail?: string) => Promise<boolean>;
  /** Abort signal for cancellation */
  signal: AbortSignal;
}

/**
 * A tool handler — defines a tool and knows how to execute it.
 */
export interface ToolHandler {
  definition: ToolDefinition;
  /** Whether this tool needs user approval before execution */
  requiresApproval(input: Record<string, unknown>): boolean;
  /** Execute the tool and return a result */
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
