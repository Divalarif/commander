/**
 * Caravan Supply Mission — Final: dock at hub and supply commission.
 * Already in Gold Run system.
 */

const MCP_URL = "https://game.spacemolt.com/mcp";
const COMMISSION_ID = "0057cc009b19620fc941102afce614e1";
const TARGET_POI = "gold_run_extraction_hub";

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
  await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "mcp-session-id": mcpSession },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })
  });
}

async function callTool(name: string, args: Record<string, unknown> = {}, retries = 3): Promise<unknown> {
  const allArgs = gameSession ? { ...args, session_id: gameSession } : args;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
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
    } catch (err) {
      if (attempt < retries - 1) {
        log(`Retry ${attempt + 1}/${retries} for ${name}: ${err}`);
        await sleep(5000);
        continue;
      }
      throw err;
    }
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function fmt(obj: unknown): string { return JSON.stringify(obj, null, 2).slice(0, 800); }
function log(msg: string) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }

async function main() {
  log("=== Caravan Supply — Final Step ===\n");
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

  // If not in gold_run, need to navigate there first
  if (player.current_system !== "gold_run") {
    log("ERROR: Not in gold_run system. Please re-run run_mission3.ts first.");
    return;
  }

  // Undock if docked somewhere else
  if (player.docked_at_base && player.docked_at_base !== TARGET_POI) {
    log("Undocking from current base...");
    await callTool("undock");
    await sleep(3000);
  }

  // Travel to extraction hub (use exact POI id)
  if (player.current_poi !== TARGET_POI) {
    log(`\n--- Traveling to ${TARGET_POI} ---`);
    const travel = await callTool("travel", { target_poi: TARGET_POI });
    log(fmt(travel));
    await sleep(15000);
  }

  // Dock
  log("\n--- Docking at Gold Run Extraction Hub ---");
  const dock = await callTool("dock");
  log(fmt(dock));
  await sleep(3000);

  // Verify docked correctly
  const s2 = await callTool("get_status") as Record<string, unknown>;
  const p2 = s2.player as Record<string, unknown>;
  log(`Docked at: ${p2.docked_at_base}`);

  if (!p2.docked_at_base) {
    log("ERROR: Failed to dock. Cannot supply commission.");
    return;
  }

  // Check commission status
  log("\n--- Commission status ---");
  const commBefore = await callTool("commission_status") as Record<string, unknown>;
  log(fmt(commBefore));

  const comm = ((commBefore as any).commissions || []).find((c: any) => c.commission_id === COMMISSION_ID);
  if (!comm) {
    log("Commission not found!");
    return;
  }
  log(`\nRequired: ${JSON.stringify(comm.required_materials)}`);
  log(`Gathered: ${JSON.stringify(comm.materials_gathered)}`);

  // Compute missing
  const required = comm.required_materials as Record<string, number>;
  const gathered = comm.materials_gathered as Record<string, number>;
  const cargo = (await callTool("get_cargo") as any).cargo as Array<{ item_id: string; quantity: number }>;
  log(`\nCargo: ${cargo.map((c: any) => `${c.item_id}x${c.quantity}`).join(", ")}`);

  // Supply each missing item individually from cargo
  log("\n--- Supplying missing items ---");
  for (const [itemId, needed] of Object.entries(required)) {
    const have = gathered[itemId] || 0;
    const missing = needed - have;
    if (missing <= 0) {
      log(`${itemId}: already supplied (${have}/${needed})`);
      continue;
    }
    const inCargo = cargo.find((c: any) => c.item_id === itemId)?.quantity || 0;
    const toSupply = Math.min(missing, inCargo);
    if (toSupply <= 0) {
      log(`${itemId}: need ${missing} but not in cargo!`);
      continue;
    }
    log(`Supplying ${itemId} x${toSupply}...`);
    const supply = await callTool("supply_commission", {
      commission_id: COMMISSION_ID,
      item_id: itemId,
      quantity: toSupply,
    });
    log(fmt(supply));
    await sleep(2000);
  }

  // Final commission status
  log("\n--- Final commission status ---");
  const commAfter = await callTool("commission_status") as Record<string, unknown>;
  const commFinal = ((commAfter as any).commissions || []).find((c: any) => c.commission_id === COMMISSION_ID);
  if (commFinal) {
    log(`Status: ${commFinal.status}`);
    log(`materials_provided: ${commFinal.materials_provided}`);
    log(`Required: ${JSON.stringify(commFinal.required_materials)}`);
    log(`Gathered: ${JSON.stringify(commFinal.materials_gathered)}`);
  }

  log("\n=== Mission complete! ===");
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
