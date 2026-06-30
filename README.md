# pi-od-mcp

A [pi](https://github.com/earendil-works/pi-mono) extension that bridges
Open Design's `od mcp` stdio MCP server into pi tools.

Open Design (OD) ships as a local-first design workspace with an MCP server
surface (`od mcp`) that exposes ~18 tools for reading project files, managing
artifacts, and commissioning design generation runs. OD's `od mcp install pi`
only prints a snippet because pi has no built-in MCP host — so this extension
spawns `od mcp` as a stdio process and dynamically registers each tool it
discovers as a first-class pi tool the LLM can call directly.

## How it works

- On first use (or at `session_start`), spawns the Open Design CLI's `mcp`
  subcommand as a stdio MCP server.
- Calls `listTools()` once and registers every tool as a pi tool named
  `od_<tool>` (e.g. `od_list_projects`, `od_get_artifact`, `od_start_run`).
- pi's argument validator accepts raw JSON Schema, so each tool's MCP
  `inputSchema` is passed straight through as the pi tool's `parameters` —
  no hand-maintained typebox schemas to drift when OD adds tools.
- Each tool forwards to `client.callTool({ name, arguments })`.
- The stdio process is lazy (nothing spawns until the first call) and is
  closed on `session_shutdown`.

## Install

```bash
pi install git:github.com/ersintarhan/pi-od-mcp
# or once published to npm:
pi install npm:pi-od-mcp
```

## Requirements

- [Open Design](https://open-design.ai/) installed and running. This extension
  auto-discovers the packaged CLI inside `Open Design.app` and the daemon
  socket under `/tmp/open-design/ipc/<namespace>/daemon.sock`.
- Node >= 22.19.

## Configuration

Environment variables (all optional):

| Variable             | Purpose                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `OD_BIN`             | Absolute path to an `od` CLI script (dev checkout or custom build).     |
| `OD_DAEMON_URL`      | Override daemon discovery (passed through to `od mcp`).                 |
| `OD_SIDECAR_IPC_PATH`| Override daemon socket discovery (passed through to `od mcp`).          |
| `OD_USE_PATH_OD`     | Set to `1` to trust a bare `od` on PATH (note: system `od` is ignored). |

## Commands

- `/od-mcp-status` — show MCP connection state, discovered CLI path, and the
  daemon URL/socket in use.

## Status command example

```
> /od-mcp-status
Open Design MCP: connected
odBin: /Applications/Open Design.app/.../daemon-cli.mjs
daemonUrl: /tmp/open-design/ipc/release-stable/daemon.sock
```

## Development

```bash
git clone https://github.com/ersintarhan/pi-od-mcp
cd pi-od-mcp
npm install
npm run typecheck
```

The extension is a single `index.ts` loaded via jiti, so no build step is
needed to run it. Typecheck validates against the pi type packages.

## License

Apache-2.0
