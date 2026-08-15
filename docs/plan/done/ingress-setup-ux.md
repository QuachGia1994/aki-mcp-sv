# Plan: Section 0 (Setup) as a 3-way ingress picker

## Status
Closed — shipped. The 3-tab picker described below shipped in `scripts/config-page.js` section 0 (council item I1, room `2026.08.15-0039-aki-mcp-sv-release-018`). Tab 3 later diverged from this doc's original assumption — see Decision.

## Problem
Section 0 today describes one ingress path (Tailscale Funnel) with a hint pointing at alternatives (`PUBLIC_ORIGIN`, `--tunnel <cred.json>`) as prose, decided only via CLI flags before the panel even exists. A client has no in-panel way to see or choose their ingress.

## Direction
Turn section 0 into 3 tabs, one per ingress path:

1. **Tailscale + Funnel** — today's default, unchanged.
2. **Owned public origin** — `PUBLIC_ORIGIN`, self-hosted edge.
3. **aiobox.app** — a hosted subdomain-registration service (see the separate plan in the `aiobox` project, not designed here — this tab is the integration point, not the service itself).

Reuse the `.tabs`/`.tab`/`.tabpane` pattern already shipped in section 1 (connectors, `config-page.js` ~line 251) — do not invent a second tab mechanism (`pattern.A1`).

## The "select a cred.json" flow
The panel is bound to `127.0.0.1` already, independent of ingress — reachable before any tunnel is up. A browser `<input type="file">` cannot hand back a real OS path (browser security), so the natural shape is: client picks the file in-browser → panel backend (already a server) receives and persists its content to a real path → writes a small local config (path + origin) → next launch of `start.js` reads that config as the default ingress when no `--tunnel` flag is passed.

Restart is still required after picking (ingress is decided at `start.js` boot, not live-switchable) — word this honestly in the UI rather than implying an instant switch.

## Explicitly not decided here
- Exact endpoint names, config file location/shape, section markup.
- Whether tab 3 (aiobox.app) needs any UI beyond "enter your aiobox subdomain" until the aiobox-side plan exists.
- Whether switching tabs should warn about the pending-restart requirement inline or only after Save.

## Cross-references
- `scripts/config-page.js` section 0 (`s0`) and the section-1 tab pattern it should reuse.
- `docs/plan/cloudflare-tunnel-ingress.md` — the `--tunnel`/`PUBLIC_ORIGIN`/Funnel precedence this UI exposes.
- `docs/plan/done/standalone-packaging.md` — independent, no conflict.
- aiobox subdomain-registration plan (separate repo, `/Volumes/DEV/pj/aiobox/docs/plan/`) — owns tab 3's actual service design.

## Decision
Shipped, with one superseded assumption. The 3-tab picker (Tailscale + Funnel / Owned public origin / tab 3) shipped as designed (council item I1). Tab 3 did not become the "aiobox.app" separate-service integration point this doc assumed (see Direction and Cross-references above) — it instead became a real in-repo domain-purchase-request UI: a 4-TLD dropdown plus a Messenger contact flow, built entirely inside this repo with no external aiobox project involved (council item I8). That original integration assumption is superseded, not fulfilled as originally imagined.
