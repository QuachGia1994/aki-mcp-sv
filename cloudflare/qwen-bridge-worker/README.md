# Qwen Coder Web -> Aki Worker bridge

A narrow Cloudflare Worker ingress shared by Qwen Coder Web (`coder.qwen.ai`) and Kimi Web K3. Both clients call the same task API over HTTPS; the Worker reads/writes the existing `aki_bridge_tasks` D1 mailbox through a D1 binding; local Aki executes the requested MCP tool and stores the result. Qwen and Kimi use separate bearer secrets and owner-scoped task rows, so either client can be revoked without affecting or reading the other's tasks.

Live status (2026-08-17): verified end to end from Qwen Coder Web with both `filesystem__read_text_file` and `local__run_cmd`. Qwen Chat (`chat.qwen.ai`) uses a different execution environment and did not complete the same transport test.

```text
Qwen Coder Web
  -> HTTPS task request
  -> aki-qwen-bridge Worker
  -> D1 binding (DB)
  -> aki_bridge_tasks
  <-> local scripts/d1-bridge.js
  -> shared in-process Aki tools session/policy
```

The Worker is deliberately not a generic Cloudflare/D1 proxy. It exposes only:

- `GET /v1/health` - public liveness check; no configuration data.
- `GET /v1/ready` - authenticated D1 mailbox readiness check.
- `POST /v1/tasks` - authenticated enqueue of `{ "tool": "...", "arguments": { ... } }`; requires `Idempotency-Key` so a client can safely retry a timed-out create request.
- `GET /v1/tasks/<id>` - authenticated read of only `status`, parsed `result`, and `error`.

It cannot execute raw SQL, list all tasks, mutate status/result fields, or expose Cloudflare account/database credentials. `AKI_BRIDGE_SECRET` remains the Qwen credential; optional `AKI_KIMI_SECRET` gives Kimi an independent credential. Authentication maps each secret to its own `owner`; task lookup and idempotency are scoped by that owner, so knowing another tenant's numeric task ID does not grant access.

Each logical create uses one 16-128 character `Idempotency-Key`. A retry with the same key and identical payload returns the original task ID instead of inserting another row; reusing a key for different tool/arguments fails with HTTP 409. Qwen and Kimi may independently use the same key because the uniqueness boundary is `(owner, idempotency_key)`.

## Deployment inputs

Copy `wrangler.example.jsonc` to `wrangler.jsonc`, replace `REPLACE_WITH_D1_DATABASE_ID`, and configure `AKI_BRIDGE_SECRET` as a random value of at least 32 characters. Add `AKI_KIMI_SECRET` when Kimi should use the same Worker with a separately revocable credential. The D1 binding name must stay `DB` unless the code is changed.

The live setup and Qwen Coder helper are documented in `docs/ref/qwen-web-worker-bridge.md`.
