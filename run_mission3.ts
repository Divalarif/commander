/**
 * Caravan Supply Mission Part 3 — fixed route parsing and supply_commission args.
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
  log("=== Caravan Supply Mission Part 3 ===\n");
  await initMCP();

  log(`Logging in as ${username}...`);
  const loginResp = await callTool("login", { username, password, session_id: undefined }) as Record<string, unknown>;
  gameSession = loginResp.session_id as string;
  log(`Logged in.`);

  const status = await callTool("get_status") as Record<string, unknown>;
  const player = status.player as Record<string, unknown>;
  const ship = status.ship as Record<string, unknown>;
  log(`Location: ${player.current_system} > ${player.current_poi} | docked: ${player.docked_at_base || "no"}`);
  log(`Fuel: ${ship.fuel}/${ship.max_fuel} | Cargo: ${ship.cargo_used}/${ship.cargo_capacity}`);

  // First check supply_commission help to understand parameters
  log("\n--- Checking supply_commission help ---");
  const helpResp = await callTool("help", { command: "supply_commission" });
  log(fmt(helpResp));

  // Find route
  log("\n--- Finding route to Gold Run ---");
  const routeResp = await callTool("find_route", { target_system: TARGET_SYSTEM }) as Record<string, unknown>;
  const routeHops = ((routeResp.route as Array<{ system_id: string; name: string; jumps: number }>) || [])
    .map(h => h.system_id);
  log(`Route (${routeHops.length} systems): ${routeHops.join(" → ")}`);

  const currentSystem = player.current_system as string;

  // Undock if docked
  if (player.docked_at_base) {
    log("\n--- Undocking ---");
    const undock = await callTool("undock");
    log(fmt(undock));
    await sleep(3000);
  }

  // Jump through each system
  for (const systemId of routeHops) {
    if (systemId === currentSystem) continue; // skip current
    log(`\n--- Jumping to ${systemId} ---`);
    const jump = await callTool("jump", { target_system: systemId });
    log(fmt(jump));
    await sleep(35000); // wait for jump

    const s2 = await callTool("get_status") as Record<string, unknown>;
    const p2 = s2.player as Record<string, unknown>;
    const sh2 = s2.ship as Record<string, unknown>;
    log(`Now at: ${p2.current_system} | Fuel: ${sh2.fuel}/${sh2.max_fuel}`);

    // Refuel if below 50%
    if (Number(sh2.fuel) < Number(sh2.max_fuel) * 0.3) {
      log("Fuel low — need to refuel at next station");
    }
  }

  // Should now be in gold_run system — get POIs
  log("\n--- Gold Run system POIs ---");
  const sysInfo = await callTool("get_system") as Record<string, unknown>;
  const pois = ((sysInfo as any).system?.pois || []) as Array<{ id: string; name: string; type: string; base_id?: string }>;
  for (const poi of pois) {
    log(`  ${poi.id}: ${poi.name} (${poi.type})${poi.base_id ? ` [base: ${poi.base_id}]` : ""}`);
  }

  // Find extraction hub POI
  const hubPOI = pois.find((p: any) =>
    p.id === TARGET_BASE_ID ||
    (p.base_id === TARGET_BASE_ID) ||
    p.name?.toLowerCase().includes("extraction hub") ||
    p.name?.toLowerCase().includes("gold run")
  );
  const poiId = hubPOI?.id || TARGET_BASE_ID;
  log(`\nTargeting POI: ${poiId}`);

  // Travel to hub
  log("\n--- Traveling to hub ---");
  const travel = await callTool("travel", { target_poi: poiId });
  log(fmt(travel));
  await sleep(15000);

  // Dock
  log("\n--- Docking ---");
  const dock = await callTool("dock");
  log(fmt(dock));
  await sleep(3000);

  const s3 = await callTool("get_status") as Record<string, unknown>;
  const p3 = s3.player as Record<string, unknown>;
  log(`Docked at: ${p3.docked_at_base}`);

  // Check commission status
  log("\n--- Commission status before supply ---");
  const commBefore = await callTool("commission_status") as Record<string, unknown>;
  const comm = ((commBefore as any).commissions || []).find((c: any) => c.commission_id === COMMISSION_ID);
  if (comm) {
    log(`Status: ${comm.status}`);
    log(`Required: ${JSON.stringify(comm.required_materials)}`);
    log(`Gathered: ${JSON.stringify(comm.materials_gathered)}`);
    log(`materials_provided: ${comm.materials_provided}`);
  }

  // Supply commission — try different parameter formats
  log("\n--- Supplying commission ---");
  // Format 1: just commission_id
  const supply1 = await callTool("supply_commission", { commission_id: COMMISSION_ID });
  log("supply_commission result: " + fmt(supply1));

  // Final status
  log("\n--- Final commission status ---");
  const commAfter = await callTool("commission_status") as Record<string, unknown>;
  const commFinal = ((commAfter as any).commissions || []).find((c: any) => c.commission_id === COMMISSION_ID);
  if (commFinal) {
    log(`Status: ${commFinal.status}`);
    log(`materials_provided: ${commFinal.materials_provided}`);
    log(`materials_gathered: ${JSON.stringify(commFinal.materials_gathered)}`);
    log(`required_materials: ${JSON.stringify(commFinal.required_materials)}`);
  }

  log("\n=== Done! ===");
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
