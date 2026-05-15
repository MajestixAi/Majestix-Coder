import type { ToolDefinition } from "../api/client";
import { applyPatchTool } from "./apply-patch";
import { attemptCompletionTool } from "./attempt-completion";
import { editFileTool } from "./edit-file";
import { executeCommandTool } from "./execute-command";
import { listFilesTool } from "./list-files";
import { readFileTool } from "./read-file";
import { searchFilesTool } from "./search-files";
import type { ToolHandler } from "./types";
import { writeToFileTool } from "./write-file";
import { writePlanTool } from "./write-plan";

/**
 * All available tools, keyed by name.
 */
const allTools: Partial<Record<string, ToolHandler>> = {
  read_file: readFileTool,
  write_to_file: writeToFileTool,
  write_plan: writePlanTool,
  edit_file: editFileTool,
  apply_patch: applyPatchTool,
  list_files: listFilesTool,
  search_files: searchFilesTool,
  execute_command: executeCommandTool,
  attempt_completion: attemptCompletionTool,
};

/**
 * Maps common hallucinated tool names from other frameworks to our actual tools.
 * Many open-source models were trained on SWE-bench / OpenHands / Cline data and
 * will emit these names instead of ours.
 */
// Alias map — trained model names → our canonical names
const toolAliases: Record<string, string> = {
  // SWE-agent / OpenHands aliases
  str_replace_editor: "edit_file",
  str_replace_command: "edit_file",
  create: "write_to_file",
  create_file: "write_to_file",
  insert: "write_to_file",
  // OpenAI / Anthropic conventions
  write_file: "write_to_file",
  edit: "edit_file",
  file_edit: "edit_file",
  patch_file: "apply_patch",
  // Google Gemini conventions
  write: "write_to_file",
  readFile: "read_file",
  // DeepSeek conventions
  save_file: "write_to_file",
  // Bash / shell aliases
  bash: "execute_command",
  run_command: "execute_command",
  terminal: "execute_command",
  shell: "execute_command",
  // File reading aliases
  view: "read_file",
  open_file: "read_file",
  cat_file: "read_file",
  // Search aliases
  grep: "search_files",
  find_file: "list_files",
  // Completion aliases
  submit: "attempt_completion",
  finish: "attempt_completion",
  // Patch aliases
  patch: "apply_patch",
  diff: "apply_patch",
  // Additional Gemini/OpenAI variations
  readfile: "read_file",
  writefile: "write_to_file",
  editfile: "edit_file",
  applypatch: "apply_patch",
  executecommand: "execute_command",
  searchfiles: "search_files",
  listfiles: "list_files",
  attemptcompletion: "attempt_completion",
  // Claude-style aliases
  code_editor: "edit_file",
  // GPT-style aliases
  python: "execute_command",
  // Additional file operation aliases
  new_file: "write_to_file",
  update_file: "edit_file",
  modify_file: "edit_file",
  replace_in_file: "edit_file",
  search_and_replace: "edit_file",
  // Gemini 2.0+ specific
  file_reader: "read_file",
  file_writer: "write_to_file",
  file_editor: "edit_file",
  command_executor: "execute_command",
  // OpenAI o1/o3 specific
  code_interpreter: "execute_command",
  file_search: "search_files",
};

/**
 * Resolve a tool name, applying alias mapping if needed.
 *
 * @param name - The raw tool name from the model.
 * @returns The canonical tool name (mapped from alias if applicable).
 */
export function resolveToolName(name: string): string {
  return toolAliases[name] ?? name;
}

/**
 * Tools available per agent mode.
 */
const modeTools: Partial<Record<string, string[]>> = {
  code: [
    "read_file", "write_to_file", "edit_file", "apply_patch", "execute_command",
    "search_files", "list_files", "attempt_completion",
  ],
  architect: [
    "read_file", "write_plan", "search_files", "list_files", "attempt_completion",
  ],
  ask: [
    "read_file", "search_files", "list_files", "attempt_completion",
  ],
  askonwrite: [
    "read_file", "write_to_file", "edit_file", "apply_patch", "execute_command",
    "search_files", "list_files", "attempt_completion",
  ],
};

/**
 * Get the tool handler by name, enforcing mode-based access control.
 *
 * Returns undefined if the tool does not exist at all.
 * Returns a sentinel handler with an explanatory error if the tool exists but is
 * not allowed in the current mode — so the model receives a clear tool_result
 * error rather than silently failing or executing a forbidden operation.
 *
 * @param name - The name of the tool to look up.
 * @param mode - The current agent mode (defaults to "code").
 * @returns The tool handler, a mode-error sentinel, or undefined if unknown.
 */
export function getToolHandler(name: string, mode = "code"): ToolHandler | undefined {
  const handler = allTools[name];
  if (handler === undefined) { return undefined; }

  const allowed = modeTools[mode] ?? modeTools.code ?? [];
  if (!allowed.includes(name)) {
    // Tool exists globally but is blocked in this mode — return a sentinel that
    // yields a helpful error message back to the model so it can self-correct.
    const modeLabel = mode === "ask" ? "Ask (read-only)" : mode === "architect" ? "Architect" : mode;
    return {
      definition: handler.definition,
      requiresApproval: () => false,
      execute: () => Promise.resolve({
        tool_use_id: "",
        content: `Tool "${name}" is not available in ${modeLabel} mode. Switch to Code mode to use write/edit/execute tools.`,
        is_error: true,
      } as import("./types").ToolResult),
    };
  }

  return handler;
}

/**
 * Get tool definitions (for sending to the API) filtered by mode.
 *
 * @param mode - The agent mode to filter tools by (e.g. "code", "architect", "ask").
 * @returns An array of tool definition objects for the given mode.
 */
export function getToolDefinitions(mode = "code"): ToolDefinition[] {
  const names = modeTools[mode] ?? modeTools.code ?? [];
  return names
    .map((name) => allTools[name]?.definition)
    .filter((d): d is ToolDefinition => d !== undefined);
}

/**
 * Get all tool names for a mode.
 *
 * @param mode - The agent mode to get tool names for.
 * @returns An array of tool name strings available in the given mode.
 */
export function getToolNames(mode = "code"): string[] {
  return modeTools[mode] ?? modeTools.code ?? [];
}
