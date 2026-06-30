// Smoke test: spawn od mcp, connect, list tools, call list_projects.
// Run with OD open (packaged socket auto-discovered). Verifies the extension's
// spawn/connect/discover path end-to-end without a full pi session.
//
//   node --experimental-strip-types scripts/smoke.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const CANDIDATE_OD_BINS = [
  process.env.OD_BIN,
  "/Applications/Open Design.app/Contents/Resources/app/prebundled/daemon/daemon-cli.mjs",
].filter(Boolean);

const bin = CANDIDATE_OD_BINS.find((p) => existsSync(p));
if (!bin) {
  console.error("smoke: Open Design CLI not found. Set OD_BIN or install the packaged app.");
  process.exit(1);
}

let env = {};
if (!process.env.OD_DAEMON_URL && !process.env.OD_SIDECAR_IPC_PATH) {
  try {
    const sock = execSync("ls /tmp/open-design/ipc/*/daemon.sock 2>/dev/null | head -1", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (sock) env = { OD_SIDECAR_IPC_PATH: sock };
  } catch {
    /* od mcp will fall back to its own discovery */
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bin, "mcp"],
  env,
  stderr: "pipe",
});
const client = new Client({ name: "pi-od-mcp-smoke", version: "0" });

try {
  await client.connect(transport, { timeout: 20_000 });
  const { tools } = await client.listTools();
  console.log(`smoke: connected, ${tools.length} tools discovered`);
  console.log(`smoke: tools = ${tools.map((t) => t.name).join(", ")}`);

  const result = await client.callTool({ name: "list_projects", arguments: {} });
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  const parsed = JSON.parse(text);
  const count = parsed.projects?.length ?? 0;
  console.log(`smoke: list_projects OK (${count} project(s))`);
  await transport.close();
  process.exit(0);
} catch (error) {
  console.error(`smoke: FAILED — ${error.message}`);
  await transport.close().catch(() => undefined);
  process.exit(1);
}
