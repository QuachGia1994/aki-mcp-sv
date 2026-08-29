# Kimi/Qwen Web bridge map

Canonical flow:

```text
Kimi K3 / Qwen browser Python
  -> https://aki-bridge.oakgatekeeper.uk
  -> cloudflare/qwen-bridge-worker
  -> D1 mailbox
  -> scripts/d1-bridge.js
  -> scripts/tools-server.js
  -> result polling
```

Tracked source-of-truth files:

- `cloudflare/qwen-bridge-worker/src/index.js`
- `cloudflare/qwen-bridge-worker/wrangler.example.jsonc`
- `cloudflare/qwen-bridge-worker/README.md`
- `scripts/d1-bridge.js`
- `scripts/streamable-bridge.js`
- `scripts/tools-server.js`
- `scripts/start.js`
- `test/d1-bridge.test.js`
- `test/qwen-bridge-worker.test.js`
- `docs/ref/qwen-web-worker-bridge.md`
- `docs/ref/kimi-web-d1-bridge.md`
- `docs/ref/QWEN-WEB-LIVE-TEST.md`
- `docs/ref/KIMI-WEB-LIVE-TEST.md`

Recovery sequence:

1. Restore the repo and install dependencies.
2. Restore local bridge settings using the checked-in examples and Worker README.
3. Deploy the Worker and attach `aki-bridge.oakgatekeeper.uk`.
4. Start local Aki with `npm start`.
5. Verify `/v1/ready`.
6. Create one task with `POST /v1/tasks` and poll `/v1/tasks/:id` until `done`.
7. Run the matching browser bootstrap from `docs/ref/`.
8. Run `node --test test/d1-bridge.test.js test/qwen-bridge-worker.test.js` and `npm test`.

Failure hints:

- `401`: browser transport reached the Worker but access was not accepted.
- `202` stuck in `pending`: inspect the local D1 polling path and Aki process.
- Qwen timeout on `workers.dev`: use the custom domain first.
- `done` plus a tool error: transport works; inspect the requested Aki tool.

Keep deployment-specific local values outside Git.