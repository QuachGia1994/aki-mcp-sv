# Cloudflare Tunnel as an alternative ingress

Status: the manual escape hatch shipped in v1.7.0 (`PUBLIC_ORIGIN`, see below). The auto-`cloudflared` launcher and the drop-rate test remain design only — this stays a tradeoff study for that part, not a committed migration.

## Shipped in v1.7.0 — the manual escape hatch (`PUBLIC_ORIGIN`)

The smallest honest slice of this plan is live: `scripts/start.js` reads `PUBLIC_ORIGIN`, and when set, skips Tailscale entirely and uses that origin as-is. Everything downstream already keys off the single `origin` value, so no OAuth/gatekeeper/bridge code changed — exactly the "ingress is a swappable edge" property this doc argued for. A user who already runs a Cloudflare Tunnel (or any stable TLS edge) points it at `127.0.0.1:9999` and exports `PUBLIC_ORIGIN=https://their-host`; setup is theirs, not automated by this repo. Approach contributed via PR #4 (`@Ran-Xing`); the FRP/local-TLS path from that PR was dropped since a Cloudflare edge terminates TLS itself.

This deliberately does **not** build the `MCP_INGRESS=cloudflared` auto-launcher below — it hands the reliable-ingress option to users who want it without the repo taking on a `cloudflared` dependency or a per-user domain-provisioning burden. A managed fixed-subdomain offering (own domain, per-user subdomain, branded favicon at the apex) is a separate future project, not part of this repo's zero-config default.

## Goal

Evaluate replacing Tailscale Funnel with a Cloudflare Tunnel (`cloudflared`) as the public ingress in front of the gatekeeper, to remove the intermittent per-request drops that Funnel's edge introduces — while being honest that this breaks the repo's current zero-config, no-account, no-domain principle.

## Problem this addresses

A new failure class, distinct from the 8 rounds in `research/claude-ai-oauth-connector.md` (those are full desync: the public edge returns `000` continuously and is fixed by `serve reset`).

Here the edge is healthy — every probe returns `200` on both funnel ingress IPs — yet individual connector requests fail intermittently with Anthropic's catch-all `"This connector's server hostname doesn't resolve or isn't reachable from this network"`.

Evidence gathered 2026-08-10:
- Gatekeeper log during a failure window shows `POST /mcp -> 200` continuously (12:43:36 through 12:44:05), process pid unchanged. The failing request has **no** matching log line — it never reached the gatekeeper.
- A request that dies before the gatekeeper, while the gatekeeper is up and the edge answers `200`, can only have died at the Funnel edge or on the Anthropic↔edge hop.
- Tailscale's own docs (`kb/1223/funnel`, read 2026-08-10): *"Traffic sent over a Funnel is subject to non-configurable bandwidth limits."* No idle-timeout or keep-alive behavior is documented. Funnel is designed for low-traffic use, not sustained tool-call streams.

Conclusion: the drop is a property of the Funnel edge (undocumented bandwidth throttle / idle-connection reset), not of this repo's code, and it is not configurable from our side. The only local levers (restart, `serve reset`) do not touch it.

> Update (2026-08-11): a live retest found `serve reset` **does** temporarily clear one variant of this — a slow (not dead) ingress IP where TLS handshake runs 4–14s while the sibling IP stays ~1s. It re-binds to a healthier relay path but the degradation recurs, since the cause is Tailscale ingress health. Evidence and per-IP measurements: `docs/research/claude-ai-oauth-connector.md` round 9. Recurrence frequency is what makes this migration worth revisiting.

## Hypothesis

A Cloudflare Tunnel terminates at Cloudflare's edge with production-grade handling of long-lived and keep-alive HTTP connections, and without Funnel's unpublished bandwidth cap. Pointing the same gatekeeper at a `cloudflared` tunnel instead of Funnel should eliminate the per-request drops while leaving OAuth, the gatekeeper, and the streamable bridge untouched.

## The tradeoff — read before building

This directly contradicts a stated non-goal elsewhere in the repo (`plan/try-favicon.md`, `plan/done/init.md`): the architecture is deliberately zero-config — no Cloudflare account, no custom domain, no relay. Funnel was chosen precisely so a user runs `npm start` and nothing else.

Cloudflare Tunnel costs that simplicity. Two variants, both worse than Funnel on setup:
- **Quick Tunnel** (`cloudflared tunnel --url http://localhost:9999`): no account, random `*.trycloudflare.com` hostname regenerated every run. Zero-config like Funnel, but the public URL changes on every restart — the OAuth redirect allowlist and the pasted connector URL would break each time. Likely a non-starter for a persistent connector.
- **Named Tunnel**: stable hostname, but requires a Cloudflare account, a domain on Cloudflare DNS, and `cloudflared login` + a credentials file. This is the reliable option and the real cost.

So the honest framing: Funnel trades reliability for zero-config; a named Cloudflare Tunnel trades zero-config for reliability. This plan does not assume the trade is worth it — it scopes the experiment to find out.

## Minimal design (named tunnel, if pursued)

Keep everything behind port 9999 identical. Only the ingress layer changes.

1. `cloudflared` becomes an optional, opt-in launcher path selected by config — never the default. Mirror the existing `process.platform` data-table style (per `CLAUDE.md` OS-agnostic rule): an ingress-provider table, not a branch in business logic.
2. Provider stays `funnel` by default. A new opt-in (`MCP_INGRESS=cloudflared` or config flag) starts `cloudflared tunnel run <name>` pointing at `http://127.0.0.1:9999`.
3. The public origin (used for the OAuth issuer, redirect allowlist, and the pasted connector URL) is read from the chosen provider at runtime, exactly as the Funnel hostname is today — no hard-coded host.
4. OAuth server, gatekeeper, streamable bridge: unchanged. The whole point is that ingress is a swappable edge.

## Test

1. Stand up a named tunnel to `127.0.0.1:9999` alongside the running server.
2. Connect a fresh Claude connector through the Cloudflare hostname.
3. Drive a long tool-call session (many `Read Multiple Files`, including a large file) and watch for the `"not reachable"` catch-all over ≥30 min — the same usage that reproduces the Funnel drop.
4. Compare drop frequency against a Funnel baseline over a comparable window.
5. Confirm the gatekeeper log shows every failing request either arriving (our bug) or not arriving (edge bug), to attribute cleanly.

## Success criteria

Over a comparable window and workload, the Cloudflare hostname shows materially fewer (ideally zero) per-request drops than Funnel, with no change to the OAuth/gatekeeper code.

## Failure / stop criteria

If drops persist at a similar rate, the cause is not the Funnel edge — reopen the investigation upstream (Anthropic↔edge hop, or the streamable bridge under load) and keep Funnel for its zero-config advantage. Do not keep a Cloudflare dependency that did not earn its setup cost.

## Non-goals

- Making Cloudflare the default ingress. It stays opt-in behind a flag.
- Adding Cloudflare Access or any second auth layer — OAuth in `scripts/oauth.js` remains the only gate.
- Requiring every user to own a domain for the default path.
- A pure-JS or per-OS reimplementation of the tunnel — `cloudflared` is a single external binary, consistent with the existing "shell out to a real binary" decision.

## Decision

Manual escape hatch: shipped (v1.7.0, above) — the low-cost half that needs no repo-side automation. Auto-`cloudflared` launcher: not committed. Funnel remains the default until the test above shows Cloudflare Tunnel measurably fixes the per-request drops and the setup cost is judged acceptable for the users who hit the drops most.
