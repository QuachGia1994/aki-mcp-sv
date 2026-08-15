# Plan: Native `.env` Configuration & Multi-User Profile Support

## Status
Closed — shipped (council item I3, room `2026.08.15-0039-aki-mcp-sv-release-018`).

## Problem
Currently, overriding defaults (such as switching from Tailscale Funnel to a custom subdomain/edge via `PUBLIC_ORIGIN`, or changing ports) requires prepending environment variables on the command line or passing CLI flags (`npm start -- --origin ...`). There is no automated local `.env` loading, making multi-user / multi-machine profile setups manual and error-prone.

## Proposed Solution

1. **Native `.env` Loading in `scripts/start.js`**:
   - Use Node.js built-in `process.loadEnvFile?.()` at the very top of `scripts/start.js`.
   - Fail silently if `.env` does not exist (zero breaking change for default Tailscale flow).
   - Allow custom profile files via CLI flag or standard Node flag: `node --env-file=.env.user ./scripts/start.js`.

2. **Supported Variables**:
   - `PUBLIC_ORIGIN`: Public HTTPS URL (e.g. `https://mcp.domain.com`). Skips Tailscale when set.
   - `GATEKEEPER_PORT`: Gatekeeper & OAuth listen port (default `9999`).
   - `PANEL_PORT`: Config web UI listen port (default `9998`).
   - `MCP_HUB_PORT`: Internal mcp-hub port (default `19999`).
   - `MCP_DATA_DIR`: Workspace root directory (default `$HOME`).
   - `MCP_REQUEST_TIMEOUT_MS`: MCP request timeout (default `600000`).

3. **Template & Git Hygiene**:
   - Provide `.env.example` in repo root with commented defaults.
   - Add `.env` and `.env.*` (except `.env.example`) to `.gitignore`.

## Implementation Steps
- [x] Add `.env*` rules to `.gitignore`.
- [x] Create `.env.example` with standard defaults.
- [x] Call `process.loadEnvFile?.()` in `scripts/start.js` before reading any env vars.
- [x] Update `docs/index.md` and README to document the `.env` workflow.
