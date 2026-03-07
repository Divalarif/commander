/**
 * Caravan Supply Mission — runs directly via MCP without an LLM.
 * Buys fuel_tank x17 and sensor_array x10, travels to Gold Run Extraction Hub,
 * then supplies the commission.
 */

const MCP_URL = "https://game.spacemolt.com/mcp";
const COMMISSION_ID = "0057cc009b19620fc941102afce614e1";
const TARGET_BASE = "gold_run_extraction_hub";

import creds_json from "./sessions/default/credentials.json";
const { username, password } = creds_json as { username: string; password: string };

// ─── MCP client ──────────────────────────────────────────────

let mcpSession = "";
let gameSession = "";
let requestId = 0;

async function initMCP(): Promise<void> {
  const resp = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: ++requestId, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mission-runner", version: "1.0" } }
    })
  });
  mcpSession = resp.headers.get("mcp-session-id") || "";
  console.log(`MCP session: ${mcpSession.slice(0, 8)}...`);
  // Send initialized notification
  fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "mcp-session-id": mcpSession },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })
  }).catch(() => {});
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const allArgs = gameSession ? { ...args, session_id: gameSession } : args;
  const resp = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "mcp-session-id": mcpSession },
    body: JSON.stringify({
      jsonrpc: "2.0", id: ++requestId, method: "tools/call",
      params: { name, arguments: allArgs }
    })
  });

  // Handle both plain JSON and SSE
  const text = await resp.text();
  let jsonStr = text;
  if (text.includes("\ndata:") || text.startsWith("data:")) {
    const match = text.match(/^data:\s*(.+)$/m);
    jsonStr = match ? match[1] : text;
  }

  const data = JSON.parse(jsonStr) as { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean } };
  const content = data.result?.content || [];
  const resultText = content.filter(c => c.type === "text").map(c => c.text || "").join("\n");

  try {
    return JSON.parse(resultText);
  } catch {
    return resultText;
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function fmt(obj: unknown): string {
  return JSON.stringify(obj, null, 2).slice(0, 400);
}

// ─── Mission ─────────────────────────────────────────────────

async function main() {
  console.log("=== Caravan Supply Mission ===\n");

  await initMCP();

  // 1. Login
  console.log(`Logging in as ${username}...`);
  const loginResp = await callTool("login", { username, password, session_id: undefined }) as Record<string, unknown>;
  gameSession = loginResp.session_id as string;
  console.log(`Logged in. Game session: ${gameSession.slice(0, 8)}...`);

  // 2. Check current status
  const status = await callTool("get_status", {}) as Record<string, unknown>;
  const player = status.player as Record<string, unknown>;
  const ship = status.ship as Record<string, unknown>;
  console.log(`\nLocation: ${player.current_system} > ${player.current_poi}`);
  console.log(`Docked at: ${player.docked_at_base || "not docked"}`);
  console.log(`Credits: ${Number(player.credits).toLocaleString()}`);
  console.log(`Fuel: ${ship.fuel}/${ship.max_fuel}`);
  console.log(`Cargo: ${ship.cargo_used}/${ship.cargo_capacity}`);

  // 3. Buy fuel_tank x17 — need to buy in batches due to order sizes
  console.log("\n--- Buying fuel_tank x17 ---");
  let fuelTankBought = 0;
  while (fuelTankBought < 17) {
    const qty = Math.min(17 - fuelTankBought, 10); // max 10 per buy call
    console.log(`Buying fuel_tank x${qty}...`);
    const buyResp = await callTool("buy", { item_id: "fuel_tank", quantity: qty });
    console.log(fmt(buyResp));
    fuelTankBought += qty;
    await sleep(1000);
  }

  // 4. Buy sensor_array x10
  console.log("\n--- Buying sensor_array x10 ---");
  let sensorBought = 0;
  while (sensorBought < 10) {
    const qty = Math.min(10 - sensorBought, 10);
    console.log(`Buying sensor_array x${qty}...`);
    const buyResp = await callTool("buy", { item_id: "sensor_array", quantity: qty });
    console.log(fmt(buyResp));
    sensorBought += qty;
    await sleep(1000);
  }

  // 5. Check cargo
  const cargo = await callTool("get_cargo", {}) as Record<string, unknown>;
  console.log("\n--- Cargo after buying ---");
  console.log(fmt(cargo));

  // 6. Find route to gold_run_extraction_hub system
  console.log("\n--- Finding route to Gold Run Extraction Hub ---");
  const route = await callTool("find_route", { target_system: TARGET_BASE }) as Record<string, unknown>;
  console.log(fmt(route));

  // Try search_systems to find the system
  const systemSearch = await callTool("search_systems", { query: "gold run" }) as Record<string, unknown>;
  console.log("\n--- System search: 'gold run' ---");
  console.log(fmt(systemSearch));

  // 7. Get the map to find the system
  const currentSystem = await callTool("get_system", {}) as Record<string, unknown>;
  console.log("\n--- Current system info ---");
  console.log(fmt(currentSystem));
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
