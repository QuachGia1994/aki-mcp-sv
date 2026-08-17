# Qwen Coder Web -> Cloudflare Worker -> D1 -> Aki

Status: deployed and verified end to end with Qwen Coder Web on 2026-08-17. Qwen Chat uses a different execution environment and did not complete the same test.

## Why this path exists

Qwen Coder Web (`coder.qwen.ai`) has no confirmed custom-MCP slot, but its code environment is live-verified against this Worker and completed real Aki filesystem and shell calls. Qwen Chat (`chat.qwen.ai`) is not the same execution environment: its Python sandbox could not reach the Worker for the task-submit path, while its web extraction tool could only read the public endpoint.

Do not give Qwen a Cloudflare API token. The Worker uses a D1 binding internally and exposes only a purpose-built task API protected by revocable bearer secrets. `AKI_BRIDGE_SECRET` remains the Qwen Coder credential; optional `AKI_KIMI_SECRET` gives Kimi an independent credential without changing the API or D1 mailbox.

## Runtime flow

```text
Qwen Web code_interpreter
  -> POST /v1/tasks        Bearer AKI_BRIDGE_SECRET
  -> Cloudflare Worker
  -> D1 binding DB
  -> aki_bridge_tasks
  -> local scripts/d1-bridge.js polls D1
  -> mcp-hub tools/list + tools/call
  -> existing filesystem/local tools and policy
  -> D1 result
  -> GET /v1/tasks/<id>
  -> Qwen Web code_interpreter
```

Kimi Web can keep writing/reading the same `aki_bridge_tasks` table through its Cloudflare plugin. Claude, ChatGPT, Grok, and Gemini keep their existing MCP/OAuth transport.

## Worker API

### `GET /v1/health`

Public liveness check. Returns only:

```json
{"ok":true,"service":"aki-qwen-bridge"}
```

### `GET /v1/ready`

Requires either configured bearer secret. It verifies that the Worker can query the bound `aki_bridge_tasks` table and returns:

```json
{"ok":true,"service":"aki-qwen-bridge","d1":true}
```

A `503` with `D1 mailbox is not ready` means the D1 binding/table is not ready yet; start/configure local Aki first so `scripts/d1-bridge.js` creates the mailbox schema.

### `POST /v1/tasks`

Requires:

```text
Authorization: Bearer <client-specific-bridge-secret>
Idempotency-Key: <16-128 chars, reuse for retries of the same logical task>
Content-Type: application/json
```

Body:

```json
{
  "tool": "local__run_cmd",
  "arguments": {
    "command": "git status --short --branch",
    "cwd": "D:\\LacViet\\aki-mcp-sv"
  }
}
```

First-create response:

```json
{"id":123,"status":"pending"}
```

A retry with the same `Idempotency-Key` and byte-equivalent normalized payload returns the same task ID instead of inserting again. Reusing the key for different tool/arguments returns HTTP 409. The response header `Idempotency-Replayed` is `false` for a new row and `true` for a replay. This closes the ambiguous POST-timeout case without adding a task-list endpoint.

The Worker accepts a JSON-object `arguments`, a bounded MCP-style tool name, and a maximum request body of 32 KiB. It refuses new work once 25 tasks are already `pending`/`running`, but an already-known idempotency key is resolved before the queue-cap check.

### `GET /v1/tasks/<id>`

Requires the same bearer secret. It returns only:

```json
{
  "status": "pending|running|done|error",
  "result": null,
  "error": null
}
```

When `done`, `result` is the parsed MCP tool-result envelope. The endpoint never returns the stored tool name or arguments and there is no task-list endpoint.

## Cloudflare project files

- Worker: `cloudflare/qwen-bridge-worker/src/index.js`
- Wrangler template: `cloudflare/qwen-bridge-worker/wrangler.example.jsonc`
- Worker notes: `cloudflare/qwen-bridge-worker/README.md`
- Local D1 poller: `scripts/d1-bridge.js`

Cloudflare recommends `wrangler.jsonc` for new Worker projects. The template declares a D1 binding named `DB` and a required encrypted secret named `AKI_BRIDGE_SECRET`. The live `wrangler.jsonc` is intentionally gitignored because its database ID is installation-specific.

## Live configuration gate

The next stage must do these steps in order and verify each before continuing:

1. Create/select one D1 database for the bridge and record its database UUID/account ID.
2. Create a narrowly-scoped Cloudflare API token for local Aki with only the D1 read/write permissions required by `scripts/d1-bridge.js`.
3. Put `AKI_D1_ACCOUNT_ID`, `AKI_D1_DATABASE_ID`, `AKI_D1_API_TOKEN`, and optional `AKI_D1_POLL_MS` into Aki's local `.env`, then restart Aki and wait for `[d1-bridge] ready` so the shared table exists.
4. Copy `wrangler.example.jsonc` -> `wrangler.jsonc`, bind the same D1 database to `DB`, configure `AKI_BRIDGE_SECRET` as a separate >=32-character random secret, and deploy the Worker.
5. Verify `/v1/health`, authenticated `/v1/ready`, unauthenticated task rejection, then authenticated task enqueue/read outside Qwen.
6. Give Qwen only the Worker URL and `AKI_BRIDGE_SECRET`; never the Cloudflare account ID, database ID, D1 API token, or raw SQL.
7. Run one read-only live task first (`local__run_cmd` with `git status --short --branch`), confirm `pending -> running -> done`, then test file read and finally an explicitly allowed write action if desired.

## Qwen helper pattern

Qwen can submit and poll inside one `code_interpreter` execution, so the user experience is one natural-language request even though the transport is asynchronous:

```python
import time, uuid, requests

AKI_URL = "https://<worker-host>"
AKI_SECRET = "<dedicated-worker-secret>"
HEADERS = {"Authorization": f"Bearer {AKI_SECRET}"}

def aki(tool, arguments=None, timeout=120, idempotency_key=None):
    key = idempotency_key or uuid.uuid4().hex
    r = requests.post(
        f"{AKI_URL}/v1/tasks",
        headers={**HEADERS, "Idempotency-Key": key, "Content-Type": "application/json"},
        json={"tool": tool, "arguments": arguments or {}},
        timeout=15,
    )
    r.raise_for_status()
    task_id = r.json()["id"]
    deadline = time.time() + timeout
    while time.time() < deadline:
        s = requests.get(f"{AKI_URL}/v1/tasks/{task_id}", headers=HEADERS, timeout=15)
        s.raise_for_status()
        data = s.json()
        if data["status"] in ("done", "error"):
            return data
        time.sleep(2)
    raise TimeoutError(f"Aki task {task_id} did not finish within {timeout}s")
```

If the initial POST times out before returning a task ID, retry that POST with the **same** `idempotency_key`. Do not generate a new key for the retry.

Qwen should call only exact Aki tool names it already knows from the user's Aki instructions. The local bridge independently checks `tools/list` before `tools/call`, so an invented/non-exposed tool still fails closed.

## Security boundary

- Qwen sees only its dedicated Worker secret with authority limited to enqueueing a task and reading a task result by ID; Kimi can use a separate `AKI_KIMI_SECRET` with the same narrow authority.
- The Worker has no raw SQL endpoint, arbitrary fetch proxy, task listing, task mutation, or Cloudflare Management API credential.
- D1 is transport only. Local execution still routes through `mcp-hub`; shell allowlist/cwd containment/no-chaining and filesystem allowed-folder boundaries remain authoritative.
- A task that reached `running` is not automatically replayed after a local crash, because replaying a side-effecting tool could duplicate the side effect.
- `Idempotency-Key` protects the create boundary: a client can safely repeat a timed-out POST with the same key and payload and recover the original task ID. It does not replay a task that is already `running`.
- Rotate `AKI_BRIDGE_SECRET` independently if it is exposed in Qwen chat history. It is intentionally not the Cloudflare API token used by local Aki.

## Verification status

Local implementation tests cover public health, auth/misconfiguration failure, create validation, queue cap, minimal D1 insert shape, task-result projection, and no collection listing. Live Cloudflare/D1 behavior is verified from Qwen Coder Web through Worker -> D1 -> Aki -> D1 -> Worker, including both filesystem read and local shell status calls.
