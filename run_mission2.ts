/**
 * Caravan Supply Mission Part 2 — travel to Gold Run and supply the commission.
 */

const MCP_URL = "https://game.spacemolt.com/mcp";
const COMMISSION_ID = "0057cc009b19620fc941102afce614e1";
const TARGET_SYSTEM = "gold_run";
const TARGET_BASE_ID = "gold_run_extraction_hub";

import creds_json from "./sessions/default/credentials.json";
const { username, password } = creds_json as { username: string; password: string };

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
  fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "mcp-session-id": mcpSession },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })
  }).catch(() => {});
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const allArgs = gameSession ? { ...args, session_id: gameSession } : args;
  const resp = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "mcp-session-id": mcpSession },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: allArgs } })
  });
  const text = await resp.text();
  let jsonStr = text;
  if (text.includes("\ndata:") || text.startsWith("data:")) {
    const match = text.match(/^data:\s*(.+)$/m);
    jsonStr = match ? match[1] : text;
  }
  const data = JSON.parse(jsonStr) as { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean } };
  const content = data.result?.content || [];
  const resultText = content.filter((c: any) => c.type === "text").map((c: any) => c.text || "").join("\n");
  try { return JSON.parse(resultText); } catch { return resultText; }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function fmt(obj: unknown): string { return JSON.stringify(obj, null, 2).slice(0, 600); }
function log(msg: string) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }

async function main() {
  log("=== Caravan Supply Mission — Part 2: Travel & Supply ===\n");
  await initMCP();

  // Login
  log(`Logging in as ${username}...`);
  const loginResp = await callTool("login", { username, password, session_id: undefined }) as Record<string, unknown>;
  gameSession = loginResp.session_id as string;
  log(`Logged in. Game session: ${gameSession.slice(0, 8)}...`);

  // Status check
  const status = await callTool("get_status") as Record<string, unknown>;
  const player = status.player as Record<string, unknown>;
  const ship = status.ship as Record<string, unknown>;
  log(`Location: ${player.current_system} > ${player.current_poi} | docked: ${player.docked_at_base || "no"}`);
  log(`Credits: ${Number(player.credits).toLocaleString()} | Fuel: ${ship.fuel}/${ship.max_fuel} | Cargo: ${ship.cargo_used}/${ship.cargo_capacity}`);

  // Find route from sol to gold_run
  log("\n--- Finding route to Gold Run ---");
  const route = await callTool("find_route", { target_system: TARGET_SYSTEM }) as Record<string, unknown>;
  log(fmt(route));

  const routeHops = (route.route as string[]) || [];
  log(`Route: ${routeHops.join(" → ")}`);

  // Undock from current base
  if (player.docked_at_base) {
    log("\n--- Undocking ---");
    const undock = await callTool("undock");
    log(fmt(undock));
    await sleep(2000);
  }

  // Jump through each system in the route (skip current system)
  for (const systemId of routeHops.slice(1)) {
    log(`\n--- Jumping to ${systemId} ---`);
    const jump = await callTool("jump", { target_system: systemId });
    log(fmt(jump));
    await sleep(35000); // jumps can take up to 30s

    const s2 = await callTool("get_status") as Record<string, unknown>;
    const p2 = s2.player as Record<string, unknown>;
    const sh2 = s2.ship as Record<string, unknown>;
    log(`Now at: ${p2.current_system} | Fuel: ${sh2.fuel}/${sh2.max_fuel}`);
  }

  // Now we should be in gold_run system — find the extraction hub POI
  log("\n--- Getting Gold Run system info ---");
  const sysInfo = await callTool("get_system") as Record<string, unknown>;
  const pois = (sysInfo as any).system?.pois || [];
  log(`POIs in system:`);
  for (const poi of pois) {
    log(`  ${poi.id}: ${poi.name} (${poi.type})`);
  }

  // Find the extraction hub POI ID
  const hubPOI = pois.find((p: any) => p.id === TARGET_BASE_ID || p.name?.toLowerCase().includes("gold run"));
  log(`\nTarget POI: ${hubPOI ? JSON.stringify(hubPOI) : "not found directly — will try travel"}`);

  // Travel to extraction hub
  log("\n--- Traveling to Gold Run Extraction Hub ---");
  const travel = await callTool("travel", { target_poi: TARGET_BASE_ID });
  log(fmt(travel));
  await sleep(15000);

  // Dock
  log("\n--- Docking at Gold Run Extraction Hub ---");
  const dock = await callTool("dock", { base_id: TARGET_BASE_ID });
  log(fmt(dock));
  await sleep(3000);

  // Check cargo before supply
  const cargo = await callTool("get_cargo") as Record<string, unknown>;
  log(`\nCargo: ${JSON.stringify((cargo as any).cargo?.map((c: any) => `${c.item_id}x${c.quantity}`))}`);

  // Supply commission
  log("\n--- Supplying materials to commission ---");
  const supply = await callTool("supply_commission", { commission_id: COMMISSION_ID });
  log(fmt(supply));

  // Verify commission status
  log("\n--- Final commission status ---");
  const commStatus = await callTool("commission_status");
  const comms = (commStatus as any).commissions || [];
  for (const c of comms) {
    if (c.commission_id === COMMISSION_ID) {
      log(`Commission: ${c.ship_class_id} "${c.ship_name}"`);
      log(`Status: ${c.status}`);
      log(`materials_provided: ${c.materials_provided}`);
      log(`materials_gathered: ${JSON.stringify(c.materials_gathered)}`);
    }
  }

  log("\n=== Mission complete! ===");
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
