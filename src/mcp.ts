import { log, logError } from "./ui.js";
import type { ApiResponse } from "./api.js";

// ─── MCP Protocol Types ───────────────────────────────────────

interface MCPToolSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface MCPCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

const MAX_RECONNECT_ATTEMPTS = 6;
const RECONNECT_BASE_DELAY = 5_000;

/**
 * SpaceMolt MCP client. Implements the same `execute()` interface as
 * SpaceMoltAPI so that it can be used as a drop-in replacement, while
 * using the MCP Streamable HTTP transport (JSON-RPC 2.0 over POST).
 *
 * MCP session: managed via the `mcp-session-id` response header.
 * Game session: managed via the `session_id` field injected into every
 *   tool call, returned by `login` / `register`.
 */
export class SpaceMoltMCP {
  readonly baseUrl: string;
  private mcpSessionId: string | null = null;
  private gameSessionId: string | null = null;
  private credentials: { username: string; password: string } | null = null;
  private initialized = false;

  constructor(mcpUrl?: string) {
    this.baseUrl = mcpUrl || process.env.SPACEMOLT_MCP_URL || "https://game.spacemolt.com/mcp";
  }

  setCredentials(username: string, password: string): void {
    this.credentials = { username, password };
  }

  // ─── Public execute() — same interface as SpaceMoltAPI ──────

  async execute(command: string, payload?: Record<string, unknown>): Promise<ApiResponse> {
    try {
      await this.ensureMCPSession();
    } catch {
      return { error: { code: "connection_failed", message: "Could not connect to MCP server" } };
    }

    // Inject game session_id if we have one
    const args: Record<string, unknown> = { ...(payload || {}) };
    if (this.gameSessionId && command !== "login" && command !== "register") {
      args.session_id = this.gameSessionId;
    }

    let result: MCPCallResult;
    try {
      result = await this.callTool(command, args);
    } catch {
      // Network error — reconnect and retry
      log("system", "MCP connection lost, reconnecting...");
      this.mcpSessionId = null;
      this.initialized = false;
      try {
        await this.ensureMCPSession();
        result = await this.callTool(command, args);
      } catch {
        return { error: { code: "connection_failed", message: "Could not reconnect to MCP server" } };
      }
    }

    return this.parseMCPResult(command, result, args);
  }

  // ─── List available game tools ───────────────────────────────

  async listTools(): Promise<MCPToolSchema[]> {
    await this.ensureMCPSession();

    const resp = await this.rpc("tools/list", {});
    const tools = resp.result?.tools;
    if (!Array.isArray(tools)) return [];
    return tools as MCPToolSchema[];
  }

  // ─── Internal: MCP session lifecycle ────────────────────────

  private async ensureMCPSession(): Promise<void> {
    if (this.initialized && this.mcpSessionId) return;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        await this.initializeMCP();

        // Re-authenticate if we have credentials
        if (this.credentials && !this.gameSessionId) {
          await this.loginWithCredentials();
        }
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const delay = RECONNECT_BASE_DELAY * Math.pow(2, attempt);
        log("system", `MCP server unreachable (attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS}), retrying in ${delay / 1000}s...`);
        await sleep(delay);
      }
    }
    throw lastError || new Error("Failed to connect to MCP server");
  }

  private async initializeMCP(): Promise<void> {
    log("system", this.mcpSessionId ? "Renewing MCP session..." : "Initializing MCP session...");

    const url = this.baseUrl;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.mcpSessionId) headers["mcp-session-id"] = this.mcpSessionId;

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "sm-commander", version: "1.0.0" },
      },
    });

    const resp = await fetch(url, { method: "POST", headers, body });
    if (!resp.ok) {
      throw new Error(`MCP initialize failed: ${resp.status} ${resp.statusText}`);
    }

    // Capture session ID from response header
    const newSessionId = resp.headers.get("mcp-session-id");
    if (newSessionId) {
      this.mcpSessionId = newSessionId;
      log("system", `MCP session: ${newSessionId.slice(0, 8)}...`);
    }

    const data = await resp.json() as { result?: unknown; error?: unknown };
    if (!data.result) {
      throw new Error("MCP initialize: no result in response");
    }

    // Send initialized notification (fire-and-forget)
    this.sendNotification("notifications/initialized", {}).catch(() => {});

    this.initialized = true;
  }

  private async loginWithCredentials(): Promise<void> {
    if (!this.credentials) return;
    log("system", `MCP: logging in as ${this.credentials.username}...`);

    try {
      const result = await this.callTool("login", {
        username: this.credentials.username,
        password: this.credentials.password,
      });

      const parsed = this.extractJSON(result);
      const sid = parsed?.session_id;
      if (sid && typeof sid === "string") {
        this.gameSessionId = sid;
        log("system", "MCP: game session established");
      } else {
        logError("MCP: login did not return a session_id");
      }
    } catch (err) {
      logError(`MCP: login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Internal: RPC helpers ───────────────────────────────────

  private requestId = 0;

  private async rpc(method: string, params: unknown): Promise<{ result?: any; error?: any }> {
    const id = ++this.requestId;
    const url = this.baseUrl;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.mcpSessionId) headers["mcp-session-id"] = this.mcpSessionId;

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });

    if (!resp.ok) {
      throw new Error(`MCP RPC ${method} failed: ${resp.status} ${resp.statusText}`);
    }

    // Update session ID if server rotates it
    const newSession = resp.headers.get("mcp-session-id");
    if (newSession && newSession !== this.mcpSessionId) {
      this.mcpSessionId = newSession;
    }

    return resp.json() as Promise<{ result?: any; error?: any }>;
  }

  private async sendNotification(method: string, params: unknown): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.mcpSessionId) headers["mcp-session-id"] = this.mcpSessionId;

    await fetch(this.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    }).catch(() => {});
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<MCPCallResult> {
    const data = await this.rpc("tools/call", { name, arguments: args });

    if (data.error) {
      // MCP-level error (not game error)
      throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
    }

    return data.result as MCPCallResult;
  }

  // ─── Result parsing ──────────────────────────────────────────

  private parseMCPResult(
    command: string,
    mcpResult: MCPCallResult,
    args: Record<string, unknown>,
  ): ApiResponse {
    // Extract text content from MCP result
    const textContent = mcpResult.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");

    // Try to parse as JSON (most game commands return JSON)
    const parsed = this.extractJSON({ content: mcpResult.content } as unknown as MCPCallResult);

    if (mcpResult.isError) {
      // Game-level error returned as tool error
      const errObj = parsed as { error?: { code?: string; message?: string; wait_seconds?: number }; code?: string; message?: string; wait_seconds?: number } | null;
      const errorCode = errObj?.error?.code || errObj?.code || "game_error";
      const errorMessage = errObj?.error?.message || errObj?.message || textContent || "Unknown error";

      // Handle rate limiting
      if (errorCode === "rate_limited") {
        const waitSeconds = errObj?.error?.wait_seconds || errObj?.wait_seconds || 10;
        log("wait", `Rate limited — sleeping ${waitSeconds}s...`);
        return sleep(Math.ceil(waitSeconds * 1000)).then(() =>
          this.execute(command, Object.fromEntries(
            Object.entries(args).filter(([k]) => k !== "session_id")
          ))
        ) as unknown as ApiResponse;
      }

      // Handle session expiry
      if (errorCode === "session_invalid" || errorCode === "session_expired" || errorCode === "not_authenticated" || errorCode === "session_required") {
        log("system", "Game session expired, re-authenticating...");
        this.gameSessionId = null;
        return this.ensureMCPSession().then(() =>
          this.execute(command, Object.fromEntries(
            Object.entries(args).filter(([k]) => k !== "session_id")
          ))
        ) as unknown as ApiResponse;
      }

      return { error: { code: errorCode, message: errorMessage } };
    }

    // Capture session_id from login/register responses
    const parsedSid = parsed?.session_id;
    if (parsedSid && typeof parsedSid === "string" && (command === "login" || command === "register")) {
      this.gameSessionId = parsedSid;
      log("system", `Game session established via ${command}`);
    }

    // Extract notifications if present
    const notifications = parsed?.notifications || undefined;

    // Return in ApiResponse format
    return {
      result: parsed ?? textContent,
      notifications: Array.isArray(notifications) ? notifications : undefined,
    };
  }

  private extractJSON(result: MCPCallResult): Record<string, unknown> | null {
    const text = result.content
      ?.filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");

    if (!text) return null;

    // Try to parse the whole text as JSON
    try {
      return JSON.parse(text.trim());
    } catch {
      // Try to find a JSON object in the text
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {
          return null;
        }
      }
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
