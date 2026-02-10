import type { Tool } from "@mariozechner/pi-ai";
import { log, logError } from "./ui.js";

/**
 * Fetch the OpenAPI spec from the gameserver and convert each path
 * into a pi-ai Tool definition. This keeps tool definitions always
 * in sync with the server without manual maintenance.
 */
export async function fetchGameTools(baseUrl: string): Promise<Tool[]> {
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
    log("system", "Falling back to empty remote tool list — agent can use get_commands at runtime");
    return [];
  }

  const paths: Record<string, any> = spec.paths ?? {};
  const tools: Tool[] = [];

  for (const [path, methods] of Object.entries(paths)) {
    const op = methods?.post;
    if (!op) continue;

    const name: string = op.operationId;
    if (!name) continue;

    // Skip /session — handled internally by api.ts
    if (name === "createSession" || path === "/session") continue;

    // Build description: summary + mutation/query indicator
    const isMutation = !!op["x-is-mutation"];
    const desc = `${op.summary || name} [${isMutation ? "mutation" : "query"}]`;

    // Extract requestBody JSON Schema or default to empty object
    const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
    const parameters = bodySchema ?? { type: "object", properties: {} };

    tools.push({ name, description: desc, parameters });
  }

  log("system", `Loaded ${tools.length} game tools from OpenAPI spec`);
  return tools;
}
