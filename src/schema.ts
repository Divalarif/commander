import { log, logError } from "./ui.js";
import type { SpaceMoltMCP } from "./mcp.js";

export interface GameCommandInfo {
  name: string;
  description: string;
  isMutation: boolean;
}

/**
 * Fetch the OpenAPI spec from the gameserver and extract command names
 * and short descriptions. Returns a compact summary instead of full
 * tool schemas to save tokens.
 */
export async function fetchGameCommands(baseUrl: string): Promise<GameCommandInfo[]> {
  // baseUrl is like https://game.spacemolt.com/api/v1
  // OpenAPI spec is at   https://game.spacemolt.com/api/openapi.json
  const specUrl = baseUrl.replace(/\/v\d+\/?$/, "/openapi.json");

  let spec: any;
  try {
    const resp = await fetch(specUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    spec = await resp.json();
  } catch (err) {
    logError(`Failed to fetch OpenAPI spec from ${specUrl}: ${err instanceof Error ? err.message : err}`);
    log("system", "Falling back to empty command list — agent can use get_commands at runtime");
    return [];
  }

  const paths: Record<string, any> = spec.paths ?? {};
  const commands: GameCommandInfo[] = [];

  for (const [path, methods] of Object.entries(paths)) {
    const op = methods?.post;
    if (!op) continue;

    const name: string = op.operationId;
    if (!name) continue;

    // Skip /session — handled internally by api.ts
    if (name === "createSession" || path === "/session") continue;

    const isMutation = !!op["x-is-mutation"];
    const description = op.summary || name;

    commands.push({ name, description, isMutation });
  }

  log("system", `Loaded ${commands.length} game commands from OpenAPI spec`);
  return commands;
}

/**
 * Fetch game commands from the MCP server's tools/list endpoint.
 * Mutations are identified by the `x-mutation` annotation in the tool
 * description (falling back to a keyword heuristic).
 */
export async function fetchGameCommandsFromMCP(mcpClient: SpaceMoltMCP): Promise<GameCommandInfo[]> {
  try {
    const tools = await mcpClient.listTools();
    const commands: GameCommandInfo[] = [];

    // Internal MCP tools that shouldn't be exposed as game commands
    const skip = new Set(["login", "register", "logout", "help", "get_commands"]);

    for (const tool of tools) {
      if (!tool.name) continue;
      if (skip.has(tool.name)) continue;

      const description = tool.description || tool.name;
      // Heuristic: commands that modify state are mutations
      const mutationKeywords = /^(mine|travel|jump|dock|undock|sell|buy|craft|refuel|repair|attack|chat|forum|faction|deposit|withdraw|jettison|install|uninstall|create|delete|set|send|trade|claim|accept|decline|abandon|complete|commission|cancel|logout|reload|cloak|battle|tow|release|salvage|scrap|loot|survey|use_item|transfer|inspect|post|supply)/i;
      const isMutation = mutationKeywords.test(tool.name);

      commands.push({ name: tool.name, description: description.slice(0, 120), isMutation });
    }

    log("system", `Loaded ${commands.length} game commands from MCP tools/list`);
    return commands;
  } catch (err) {
    logError(`Failed to fetch commands from MCP: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/**
 * Format commands as a compact pipe-separated list for the system prompt.
 * Queries and mutations are separated for clarity.
 */
export function formatCommandList(commands: GameCommandInfo[]): string {
  const queries = commands.filter(c => !c.isMutation).map(c => c.name);
  const mutations = commands.filter(c => c.isMutation).map(c => c.name);

  const lines: string[] = [];
  if (queries.length > 0) {
    lines.push(`Query commands (free, no tick cost): ${queries.join("|")}`);
  }
  if (mutations.length > 0) {
    lines.push(`Action commands (costs 1 tick): ${mutations.join("|")}`);
  }
  return lines.join("\n");
}
