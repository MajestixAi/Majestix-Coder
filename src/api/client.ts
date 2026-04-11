import * as vscode from "vscode";

import { ApiKeyManager } from "../auth/api-key";

interface RateLimitBody {
  code?: string;
  message?: string;
  retry_after?: number;
  credits_remaining?: number;
  credits_required?: number;
  plan?: string;
}

/**
 * Parse a 429 response body into a human-readable error message.
 *
 * @param raw - The parsed JSON body from a 429 response.
 * @returns A human-readable string describing the rate limit or quota error.
 */
function parse429(raw: RateLimitBody & { detail?: RateLimitBody }): string {
  // FastAPI wraps HTTPException bodies as {"detail": {...}}
  const body: RateLimitBody = raw.detail ?? raw;
  const retryIn = typeof body.retry_after === "number" ? ` Try again in ${String(body.retry_after)}s.` : "";

  if (body.code === "QUOTA_EXCEEDED") {
    return "You're out of credits. Top up at majestix.ai/billing.";
  }

  if (body.code === "RATE_LIMITED") {
    const plan = typeof body.plan === "string" && body.plan.length > 0 ? ` (${body.plan} plan)` : "";
    return `Rate limit exceeded${plan}.${retryIn}`;
  }

  if (body.code === "IP_RATE_LIMITED") {
    return `Too many requests from your network.${retryIn}`;
  }

  if (typeof body.message === "string" && body.message.length > 0) {
    return `${body.message}${retryIn}`;
  }

  return `Rate limited — wait a moment and try again.${retryIn}`;
}

export interface ApiError {
  status: number;
  detail: string;
}

/**
 * HTTP client for the Majestix harness API. Handles authentication, error handling,
 * and SSE streaming for the agentic code endpoint.
 */
export class MajestixClient {
  /**
   * Creates a MajestixClient using the given API key manager for authentication.
   *
   * @param keyManager - The manager used to retrieve and prompt for the API key.
   */
  constructor(private keyManager: ApiKeyManager) {}

  /**
   * Make an authenticated request to the Majestix API.
   *
   * @param path - The API path to request (e.g. "/models").
   * @param options - Optional request configuration.
   * @param options.method - HTTP method (default "GET").
   * @param options.body - Optional request body to JSON-serialize.
   * @param options.signal - Optional AbortSignal to cancel the request.
   * @returns The raw Response object from the API.
   */
  async fetch(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
    } = {}
  ): Promise<Response> {
    const apiKey = await this.keyManager.requireKey();
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error("No API key configured");
    }

    const url = `${this.getBaseUrl()}${path}`;
    const headers: Record<string, string> = {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
    };

    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== null && options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });

    if (res.status === 401) {
      void vscode.window
        .showErrorMessage(
          "Majestix AI: API key is invalid or expired.",
          "Update Key"
        )
        .then((choice) => {
          if (choice === "Update Key") {
            void this.keyManager.promptForKey();
          }
        });
      throw new Error("Invalid API key");
    }

    if (res.status === 402) {
      void vscode.window.showErrorMessage(
        "Majestix AI: Insufficient credits. Top up your balance in the web dashboard."
      );
      throw new Error("Insufficient credits");
    }

    if (res.status === 429) {
      let rateLimitMsg = "Rate limited — wait a moment and try again.";
      try {
        rateLimitMsg = parse429((await res.json()) as RateLimitBody);
      } catch { /* ignore JSON parse failures */ }
      void vscode.window.showWarningMessage(`Majestix AI: ${rateLimitMsg}`);
      throw new Error(rateLimitMsg);
    }

    if (res.status === 503) {
      void vscode.window.showErrorMessage(
        "Majestix AI: Service temporarily unavailable. Please try again shortly."
      );
      throw new Error("Service unavailable");
    }

    if (!res.ok) {
      let detail = res.statusText;
      try {
        const err = (await res.json()) as { detail?: string };
        detail = err.detail ?? detail;
      } catch { /* ignore JSON parse failures */ }
      throw new Error(`API error (${String(res.status)}): ${detail}`);
    }

    return res;
  }

  /**
   * GET /models — list available models.
   *
   * @returns An object containing the array of available model info records.
   */
  async getModels(): Promise<{ models: ModelInfo[] }> {
    const res = await this.fetch("/models");
    return (await res.json()) as { models: ModelInfo[] };
  }

  /**
   * GET /usage/me — get credit usage.
   *
   * @returns The current usage and credit balance information.
   */
  async getUsage(): Promise<UsageInfo> {
    const res = await this.fetch("/usage/me");
    return (await res.json()) as UsageInfo;
  }

  /**
   * POST /code — agentic tool-use streaming.
   * Yields text chunks and tool_use events, then a final done event.
   *
   * @param request - The code request payload including messages, model, tools, etc.
   * @param signal - Optional AbortSignal to cancel the streaming request.
   * @returns An async generator that yields stream events as they arrive.
   */
  async *codeStream(
    request: CodeRequest,
    signal?: AbortSignal
  ): AsyncGenerator<CodeStreamEvent> {
    const apiKey = await this.keyManager.requireKey();
    if (apiKey === undefined || apiKey.length === 0) {throw new Error("No API key configured");}

    const url = `${this.getBaseUrl()}/code`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...request, stream: true }),
      signal,
    });

    if (!res.ok) {
      if (res.status === 402) {
        throw new Error("Insufficient credits — top up in the web dashboard");
      }
      if (res.status === 429) {
        let rateLimitMsg = "Rate limited — wait a moment and try again.";
        try {
          rateLimitMsg = parse429((await res.json()) as RateLimitBody);
        } catch { /* ignore JSON parse failures */ }
        throw new Error(rateLimitMsg);
      }
      let detail = res.statusText;
      try {
        const err = (await res.json()) as { detail?: string };
        detail = err.detail ?? detail;
      } catch { /* ignore JSON parse failures */ }
      throw new Error(`API error (${String(res.status)}): ${detail}`);
    }

    const reader = res.body?.getReader();
    if (reader === undefined) {throw new Error("No response body");}

    const decoder = new TextDecoder();
    let buffer = "";

    // 60 s with no data = server hung or connection silently dead.
    // Also races against the AbortSignal so the stop button works even
    // after fetch() has resolved (Node does not reliably cancel the reader
    // when the signal fires post-response).
    const CHUNK_TIMEOUT_MS = 60_000;

    const readWithTimeout = (): Promise<ReadableStreamReadResult<Uint8Array>> =>
      new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const timer = setTimeout(() => {
          reader.cancel().catch(() => {/* ignore */});
          reject(new Error("stream timeout — no data received for 60 s"));
        }, CHUNK_TIMEOUT_MS);

        const onAbort = (): void => {
          clearTimeout(timer);
          reader.cancel().catch(() => {/* ignore */});
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        reader.read().then(
          result => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve(result);
          },
          (err: unknown) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        );
      });

    try {
      for (;;) {
        if (signal?.aborted === true) {break;}

        const { done, value } = await readWithTimeout();
        if (done) {break;}

        buffer += decoder.decode(value, { stream: true });

        const { events, remaining } = parseSseBuffer(buffer);
        buffer = remaining;

        for (const payload of events) {
          try {
            const event: CodeStreamEvent = JSON.parse(payload) as CodeStreamEvent;
            yield event;
          } catch (e) {
            console.error("[Majestix SSE] Failed to parse event:", payload.slice(0, 200), e);
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {/* ignore */});
    }

    // Flush any final decoder bytes and parse trailing complete frame(s)
    buffer += decoder.decode();
    const { events } = parseSseBuffer(buffer);
    for (const payload of events) {
      try {
        const event: CodeStreamEvent = JSON.parse(payload) as CodeStreamEvent;
        yield event;
      } catch (e) {
        console.error("[Majestix SSE] Failed to parse trailing event:", payload.slice(0, 200), e);
      }
    }
  }

  /**
   * Returns the configured base URL for the Majestix API.
   *
   * @returns The base URL string from workspace settings.
   */
  private getBaseUrl(): string {
    return vscode.workspace
      .getConfiguration("majestix")
      .get<string>(
        "apiUrl",
        "https://api.majestix.ai"
      );
  }
}

/**
 * Parses an SSE buffer string into complete event payloads and returns remaining incomplete data.
 *
 * @param buffer - The raw SSE text buffer accumulated from the response stream.
 * @returns An object with an array of parsed event strings and the remaining unparsed buffer.
 */
function parseSseBuffer(buffer: string): { events: string[]; remaining: string } {
  const events: string[] = [];
  let remaining = buffer;

  for (;;) {
    const delimiterIndex = remaining.indexOf("\n\n");
    if (delimiterIndex === -1) {break;}

    const rawFrame = remaining.slice(0, delimiterIndex);
    remaining = remaining.slice(delimiterIndex + 2);

    const lines = rawFrame.replace(/\r/g, "").split("\n");
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length > 0) {
      events.push(dataLines.join("\n"));
    }
  }

  return { events, remaining };
}

// --- Types ---

export interface ModelInfo {
  key: string;
  display_name: string;
  provider: string;
  category: string;
  context_window: number;
  is_custom: boolean;
  supports_tools?: boolean;
}

export interface UsageInfo {
  plan: string;
  plan_allocation: number;
  plan_credits_remaining: number;
  topup_balance: number;
  this_month: Record<string, unknown>;
  by_model: Record<string, unknown>;
}

// --- /code endpoint types ---

export interface CodeRequest {
  messages: Message[];
  model?: string | null;
  system?: string | null;
  tools?: ToolDefinition[] | null;
  temperature?: number;
  max_tokens?: number;
  enable_thinking?: boolean;
  stream?: boolean;
}

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type CodeStreamEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "thinking_done" }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "done"; model: string; model_display_name: string; routed: boolean; credits_used: number; usage: { input_tokens: number; output_tokens: number } }
  | { type: "error"; detail: string };
