// pi extension: bridge Open Design's `od mcp` stdio MCP server into pi tools.
//
// How it works:
//  - On first tool use, spawn `od mcp` (path from OD_BIN env, run via node) as a
//    stdio MCP server. The daemon URL is resolved by OD_DAEMON_URL/OD_SIDECAR_IPC_PATH
//    (od's own discovery; defaults to http://127.0.0.1:7456).
//  - Call listTools() once, register each as a pi tool. pi's validateToolArguments
//    accepts raw JSON Schema (it runs Compile() + a JSON-Schema coercion path), so
//    we pass the MCP inputSchema straight through — no hand-written typebox needed.
//  - Each tool forwards to client.callTool({ name, arguments }).
//
// Lazy: nothing spawns until the first tool call. Closed on session_shutdown.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";

const EXTENSION_NAME = "pi-od-mcp";
const DEFAULT_TIMEOUT_MS = 600_000; // OD generation runs can take minutes.

// Packaged daemon CLI lives inside the .app bundle. Checked in order so a dev
// checkout (apps/daemon/bin/od.mjs) or an explicit OD_BIN override still wins.
const CANDIDATE_OD_BINS = [
  process.env.OD_BIN,
  "/Applications/Open Design.app/Contents/Resources/app/prebundled/daemon/daemon-cli.mjs",
  join(process.cwd(), "apps/daemon/bin/od.mjs"),
];

function resolveOdCommand(): { command: string; args: string[] } {
  // A bare `od` on PATH that is actually Open Design's CLI (system `od` is
  // OpenBSD disk-dump). Only trust it when the user opts in via OD_USE_PATH_OD=1.
  if (process.env.OD_USE_PATH_OD === "1") {
    try {
      const which = execSync("command -v od 2>/dev/null", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (which && which !== "/usr/bin/od") return { command: which, args: ["mcp"] };
    } catch {
      /* fall through */
    }
  }
  for (const bin of CANDIDATE_OD_BINS) {
    if (!bin) continue;
    try {
      // statSync throws if missing; we only need existence.
      execSync(`test -f ${JSON.stringify(bin)}`, { stdio: "ignore" });
      return { command: process.execPath, args: [bin, "mcp"] };
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `[${EXTENSION_NAME}] Open Design CLI not found. Set OD_BIN to the packaged ` +
      `daemon-cli.mjs (or od.mjs in a dev checkout), e.g. export OD_BIN="/Applications/Open Design.app/Contents/Resources/app/prebundled/daemon/daemon-cli.mjs".`,
  );
}

type ManagedServer = {
  client?: Client;
  transport?: StdioClientTransport;
  connectPromise?: Promise<Client>;
  lastError?: string;
};

const server: ManagedServer = {};

// Packaged OD runs the daemon over a POSIX socket (e.g.
// /tmp/open-design/ipc/release-stable/daemon.sock), not an HTTP port. `od mcp`
// resolves the daemon via OD_DAEMON_URL → OD_SIDECAR_IPC_PATH → default port.
// If the caller hasn't set either, auto-discover the packaged socket so the
// MCP server actually reaches the running daemon.
function resolveDaemonEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.OD_DAEMON_URL || process.env.OD_SIDECAR_IPC_PATH) return env;
  try {
    const sock = execSync(
      `ls /tmp/open-design/ipc/*/daemon.sock 2>/dev/null | head -1`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (sock) env.OD_SIDECAR_IPC_PATH = sock;
  } catch {
    /* packaged socket not present; od mcp will fall back to its own discovery */
  }
  return env;
}

async function connect(): Promise<Client> {
  if (server.client) return server.client;
  if (server.connectPromise) return server.connectPromise;

  server.connectPromise = (async () => {
    const od = resolveOdCommand();
    const transport = new StdioClientTransport({
      command: od.command,
      args: od.args,
      env: { ...resolveDaemonEnv() },
      stderr: "pipe",
    });
    const client = new Client({ name: EXTENSION_NAME, version: "0.1.0" });
    await client.connect(transport, { timeout: DEFAULT_TIMEOUT_MS });
    server.transport = transport;
    server.client = client;
    server.lastError = undefined;
    return client;
  })();

  try {
    return await server.connectPromise;
  } catch (error) {
    server.connectPromise = undefined;
    server.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

async function closeServer() {
  await server.transport?.close().catch(() => undefined);
  server.client = undefined;
  server.transport = undefined;
  server.connectPromise = undefined;
}

function summarizeMcpResult(result: unknown): string {
  if (!result || typeof result !== "object") return String(result);
  const r = result as { content?: Array<Record<string, unknown>>; isError?: boolean; structuredContent?: unknown };
  const parts: string[] = [];
  if (r.isError) parts.push("[Open Design MCP tool reported an error]");
  if (Array.isArray(r.content)) {
    for (const item of r.content) {
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
      else if (item.type === "resource" && item.resource && typeof item.resource === "object") {
        const res = item.resource as Record<string, unknown>;
        parts.push(typeof res.text === "string" ? `[${String(res.uri ?? "")}] ${res.text}` : `[${String(res.uri ?? "")}]`);
      } else parts.push(JSON.stringify(item, null, 2));
    }
  }
  if (r.structuredContent !== undefined) parts.push(`Structured content:\n${JSON.stringify(r.structuredContent, null, 2)}`);
  return parts.length ? parts.join("\n\n") : JSON.stringify(result, null, 2);
}

async function truncate(text: string): Promise<{ text: string; file?: string }> {
  const MAX = 50_000;
  if (text.length <= MAX) return { text };
  const dir = join(tmpdir(), EXTENSION_NAME);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${randomUUID()}.txt`);
  await writeFile(file, text, "utf8");
  return { text: `${text.slice(0, MAX)}\n\n[output truncated; full saved to ${file}]`, file };
}

function compactInline(value: unknown, max = 120): string {
  const t = String(value ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Generic rendering: show the tool name + compact args on call, the result text on done.
function renderCall(args: Record<string, unknown>, theme: { fg(c: string, t: string): string; bold(t: string): string }) {
  const summary = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${compactInline(typeof v === "string" ? v : JSON.stringify(v))}`)
    .join(" ");
  return new Text(`${theme.fg("toolTitle", theme.bold("od"))} ${theme.fg("accent", summary)}`, 0, 0);
}

function renderResult(
  result: { content?: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: { fg(c: string, t: string): string },
) {
  if (options.isPartial) {
    const progress = result.content?.find((c) => c.type === "text")?.text ?? "Working...";
    return new Text(`${theme.fg("warning", "running")} ${theme.fg("toolOutput", progress)}`, 0, 0);
  }
  const raw = result.content?.find((c) => c.type === "text")?.text ?? "";
  const limit = options.expanded ? 24_000 : 4_000;
  const shown = raw.length > limit ? `${raw.slice(0, limit)}\n… ${raw.length - limit} more chars omitted` : raw;
  const status = theme.fg("success", "done");
  return new Text(`${status}\n${theme.fg("toolOutput", shown)}`, 0, 0);
}

export default function odMcpExtension(pi: ExtensionAPI) {
  let discovery: Promise<void> | undefined;

  // Discover + register tools lazily, once per session. Returns when tools are
  // registered (or on error). Safe to call repeatedly; reuses the in-flight promise.
  function ensureTools(): Promise<void> {
    if (discovery) return discovery;
    discovery = (async () => {
      let client: Client;
      try {
        client = await connect();
      } catch (error) {
        server.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }

      const { tools } = await client.listTools();
      if (!tools || tools.length === 0) {
        console.warn(`[${EXTENSION_NAME}] Open Design MCP exposed no tools.`);
        return;
      }

      for (const tool of tools) {
        const name = `od_${tool.name}`;
        const description = `[Open Design] ${tool.description ?? tool.name}`;
        // parameters is raw JSON Schema; pi's validator handles non-TypeBox schemas.
        const parameters = (tool.inputSchema ?? { type: "object", properties: {}, additionalProperties: false }) as any;
        pi.registerTool({
          name,
          label: `OD ${tool.name}`,
          description,
          parameters,
          renderCall: renderCall as any,
          renderResult: renderResult as any,
          async execute(_toolCallId, params, signal, onUpdate) {
            onUpdate?.({ content: [{ type: "text", text: `Calling Open Design ${tool.name}...` }], details: {} });
            const result = await client.callTool(
              { name: tool.name, arguments: params as Record<string, unknown> },
              undefined,
              { signal, timeout: DEFAULT_TIMEOUT_MS, resetTimeoutOnProgress: true },
            );
            const text = summarizeMcpResult(result);
            if ((result as { isError?: boolean })?.isError) throw new Error(`Open Design MCP ${tool.name} failed:\n${text}`);
            const truncated = await truncate(text);
            return {
              content: [{ type: "text" as const, text: truncated.text }],
              details: { tool: tool.name, file: truncated.file },
            };
          },
        });
      }
    })();
    return discovery;
  }

  // Kick off discovery at session start so the tools exist before the first
  // turn. Non-fatal if OD isn't running yet; the first od_* call will surface
  // the error, and the user can start OD and /reload.
  pi.on("session_start", async (_event, ctx) => {
    try {
      await ensureTools();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`Open Design MCP not ready: ${msg}`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    await closeServer();
  });

  // A status command so the user can debug connectivity.
  pi.registerCommand("od-mcp-status", {
    description: "Show Open Design MCP connection + registered tools",
    handler: async (_args, ctx) => {
      const connected = Boolean(server.client);
      const status = {
        connected,
        lastError: server.lastError,
        odBin: process.env.OD_BIN ?? "(unset)",
        daemonUrl: process.env.OD_DAEMON_URL ?? process.env.OD_SIDECAR_IPC_PATH ?? "(default 127.0.0.1:7456)",
      };
      ctx.ui.notify(`Open Design MCP: ${connected ? "connected" : "not connected"}\n${JSON.stringify(status, null, 2)}`, "info");
    },
  });
}
