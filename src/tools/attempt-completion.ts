import type { ToolHandler, ToolResult } from "./types";

/** Tool handler for attempt completion.
 * Provides a summary of what was accomplished and optional verification command.
 *
 * @param input - The tool input object containing `result` and optionally `command`.
 * @returns A promise that resolves to a {@link ToolResult} with the combined output.
 * @example
 * const result = await context.tools.attempt_completion.execute({ result: "Done" });
 */
export const attemptCompletionTool: ToolHandler = {
  definition: {
    name: "attempt_completion",
    description:
      "Signal that the task is complete. Provide a summary of what was accomplished. " +
      "Do NOT use this tool until you have fully completed the task and verified it works. " +
      "The user will see your result summary.",
    input_schema: {
      type: "object",
      properties: {
        result: {
          type: "string",
          description: "Summary of what was accomplished",
        },
        command: {
          type: "string",
          description:
            "Optional CLI command for the user to verify the result (e.g. 'npm test')",
        },
      },
      required: ["result"],
    },
  },

  requiresApproval: () => false,

  execute(input: Record<string, unknown>): Promise<ToolResult> {
    const result = input.result as string;
    const command = input.command as string | undefined;

    let content = result;
    if (command !== undefined && command.length > 0) {
      content += `\n\nVerification command: \`${command}\``;
    }

    return Promise.resolve({ tool_use_id: "", content });
  },
};
