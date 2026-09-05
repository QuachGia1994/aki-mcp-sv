# Kimi Web K3 via Cloudflare D1

Status: **Kimi Web K3 is end-to-end verified** on 2026-08-17 through `aki-bridge.oakgatekeeper.uk` -> Worker -> D1 -> local Aki -> shared in-process tools session -> result-by-ID. Live calls completed both `filesystem__read_text_file` (returning `commit=84894f9`) and `local__run_cmd` (`git status --short --branch`). Kimi's Cloudflare plugin direct-D1 route remains blocked by Cloudflare error 7500 on `/query`, and Kimi's IPython sandbox times out on `*.workers.dev`, so the custom-domain Worker route is the supported path.

Kimi Web does not need a custom-MCP slot for this path. Its preferred path is a narrow HTTPS bridge backed by the same D1 mailbox; direct Cloudflare-plugin D1 access remains an alternative only when the plugin is authorized to execute D1 queries. The local Aki process polls that database and calls the existing MCP tool through the shared in-process tools session, then the caller reads the result back.

## Preferred flow

```text
Kimi Web K3 IPython
  -> HTTPS Bearer request to aki-bridge.oakgatekeeper.uk
  -> shared Cloudflare Worker
  -> D1 aki_bridge_tasks
  -> scripts/d1-bridge.js (inside start.js)
  -> scripts/streamable-bridge.js shared in-process session
  -> filesystem__* / local__*
  -> D1 result row
  -> Worker result-by-ID endpoint
  -> Kimi Web K3
```

Kimi uses its own `AKI_KIMI_SECRET`; Qwen Coder keeps the separate `AKI_BRIDGE_SECRET`. The `oakgatekeeper.uk` custom domain is required for the observed Kimi sandbox because `*.workers.dev` resolved but timed out at the TCP layer.

This is asynchronous RPC over D1, not MCP transport. Existing Claude, ChatGPT, Gemini, and Grok MCP connections remain unchanged.

## 1. Create a D1 database

Use the Cloudflare dashboard or Kimi's Cloudflare plugin to create one D1 database. Record its account ID and database UUID.

Cloudflare's D1 Management API query endpoint is:

```text
POST /accounts/{account_id}/d1/database/{database_id}/query
```

The local bridge creates its table and index automatically on first successful poll, so no manual schema migration is required.

## 2. Configure Aki local

Create a Cloudflare API token scoped to the target account with D1 Read + D1 Write, then set all three required variables in `.env`:

```dotenv
AKI_D1_ACCOUNT_ID=<account-id>
AKI_D1_DATABASE_ID=<database-uuid>
AKI_D1_API_TOKEN=<api-token>
AKI_D1_POLL_MS=2000
AKI_D1_LEASE_SECONDS=900
```

`AKI_D1_POLL_MS` is optional and must be at least 500 ms. `AKI_D1_LEASE_SECONDS` defaults to 900 and requeues a task left `running` past its claim lease after a local crash/restart. The bridge is completely disabled when none of the three required D1 variables is present. A partial configuration is rejected and logged without breaking the normal MCP server.

Restart `npm start`. A healthy bridge prints:

```text
[d1-bridge] ready: account=<id>, database=<uuid>, poll=2000ms
```

Never paste `AKI_D1_API_TOKEN` into Kimi. Kimi's Cloudflare plugin authenticates to Cloudflare separately; the local token is only for the outbound Aki -> D1 poller.

## 3. Direct-plugin alternative

The original Cloudflare-plugin route can write directly to the D1 query API when that plugin's OAuth credential has permission to execute D1 queries. The observed Kimi plugin credential on 2026-08-17 could list `aki-bridge` but received Cloudflare error 7500 from `/query`, so the Worker/custom-domain path above is the verified transport target.

If direct-plugin D1 access is available, enqueue with this SQL and parameters:

```sql
INSERT INTO aki_bridge_tasks (tool, arguments_json) VALUES (?, ?)
```

Example parameters:

```json
[
  "local__run_cmd",
  "{\"command\":\"git status --short --branch\",\"cwd\":\"D:\\\\LacViet\\\\aki-mcp-sv\"}"
]
```

The D1 response metadata contains `last_row_id`; that integer is the task ID to poll.

A filesystem example uses the same envelope:

```json
[
  "filesystem__read_text_file",
  "{\"path\":\"C:\\\\Users\\\\PHONGQK\\\\.aki\\\\aki-mcp-status.json\"}"
]
```

## 4. Poll the result through direct D1 access

Query by the returned task ID:

```sql
SELECT status, result_json, error FROM aki_bridge_tasks WHERE id = ?
```

States:

- `pending`: local Aki has not claimed it yet.
- `running`: Aki claimed it. Do not enqueue the same task again automatically.
- `done`: parse `result_json` as the normal MCP tool-result envelope.
- `error`: read `error`; `result_json` may also contain the tool's MCP error envelope.

The bridge deliberately does not auto-retry a task that reached `running`. If the local process dies after a side-effecting tool executes but before the completion write reaches D1, automatic replay could execute the side effect twice. A stuck `running` row therefore requires a deliberate human/model decision to submit a new task.

A live Kimi test exposed an earlier create-boundary ambiguity: the client timed out while waiting for the initial POST response even though the Worker had already committed task `id=7`; that task later completed successfully. The Worker now requires `Idempotency-Key` on `POST /v1/tasks`. Generate one key per logical task and, if the POST times out before returning an ID, retry the same payload with the same key. The Worker returns the original task ID instead of inserting a duplicate; the task-list endpoint remains intentionally absent.

## Security boundary

D1 is only the mailbox. It cannot bypass Aki's existing tool policy:

- The bridge calls `tools/list` on the live `mcp-hub` session and rejects a tool name that the hub does not expose.
- Tool execution goes through `tools/call`, so `local__run_cmd` still passes through the existing shell allowlist, cwd containment, no-chaining parser, and optional owner-controlled `shell.allowAll` setting.
- Filesystem tools retain the same allowed-folder boundary as every normal MCP client.
- Anyone who can write rows into this D1 database can ask Aki to invoke the same exposed tools, so use a dedicated database/account permission boundary rather than sharing write access casually.

## Kimi instruction pattern

A compact instruction for Kimi Web is:

```text
When I ask you to use Aki, use the Cloudflare plugin's D1 query API. INSERT one row into aki_bridge_tasks with the exact Aki MCP tool name and JSON arguments, record meta.last_row_id, then poll SELECT status,result_json,error by that id until done/error. Never retry a row that is already running. Parse result_json as the MCP tool response and continue from that result.
```
