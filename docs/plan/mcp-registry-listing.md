# Plan — list `@akinet/akimcp` in the Official MCP Registry

Status: active · not started

## Goal

Get akimcp a canonical, namespace-verified record in the Official MCP Registry so registry-fed clients and directories (PulseMCP, Smithery and others, per third-party sources) can discover it, without waiting on any per-vendor review.

## Current state

- npm: `@akinet/akimcp` `2.1.0` is published, public access, MIT, Node `>=22`, `bin` = `akimcp`. `package.json` has no `mcpName` field.
- GitHub: `https://github.com/lacvietanh/aki-mcp-sv`.
- No `server.json` in the repo root.
- Shape: a per-user self-hosted gateway. Each user runs it on their own machine and exposes it through Tailscale Funnel or a Cloudflare tunnel with OAuth 2.1 (`package.json` description; ingress plans under `plan/done/`). There is no single production URL shared by all users.
- Gemini and Grok already connect as custom OAuth+DCR connectors, not through a directory (`plan/done/integrate-gemini-grok.md`).
- `docs/biz/` does not exist; the USP in the `package.json` description is falsifiable and is reused below.

## Steps

1. Choose the registry name (see Decisions) and add `"mcpName": "<name>"` to `package.json`. The Registry validates an npm package by reading `mcpName` from it, and the name must equal `server.json` `name`.
2. Ship the change in the next normal release. A published npm version is immutable, so `2.1.0` cannot carry `mcpName`; the release follows `plan/npm-trusted-publishing.md` and the version rules in `release.A`. Do not cut a release only for this.
3. Install `mcp-publisher` (pre-built binary or `brew install mcp-publisher`), run `mcp-publisher init` in the repo root, then edit `server.json`: `name` = `mcpName`, `version` and `packages[0].version` = the just-published npm version, `repository` = the GitHub URL above with `source: github`.
4. Set the `server.json` `description` to the falsifiable USP in one short sentence (whitelist-only shell, not a blocklist; claude.ai gets local filesystem/search/shell over Funnel + OAuth 2.1). Check the schema's length limit for `description` first, since the current `package.json` description is long.
5. Authenticate: `mcp-publisher login github` for an `io.github.*` name, or DNS authentication for a domain-based name.
6. `mcp-publisher publish`, then verify with `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=<name>"`.
7. About a week later, check PulseMCP, Smithery and Glama; claim the Glama listing (GitHub OAuth) and, if PulseMCP has not picked it up, email the Registry name, GitHub URL, version and description to `hello@pulsemcp.com` (per a maintainer discussion, third-party).
8. Follow-up, not part of this plan: automate registry publishing after the npm publish in `release.yml` (the docs have a GitHub Actions page, not yet read).

## Decisions to make

| Decision | Options | Note |
|---|---|---|
| Registry name | `io.github.lacvietanh/akimcp` (GitHub auth, simplest) · a reverse-DNS name of an owned domain such as `top.akimcp/akimcp` (DNS auth) | Docs say DNS auth enables custom-domain prefixes; the exact TXT-record procedure is on the authentication page, not yet read. Pick deliberately, a name is the listing's identity. |
| Version to carry it | next planned release · a patch release | Follow `release.A`; the version is minted at the release event, not ahead of it. |

## Open questions (read before step 3)

- `server.json` `packages[].transport` for akimcp: the npm package launches a local gateway that serves Streamable HTTP, it is not a plain stdio server. Read the Registry pages `package-types` and `remote-servers` to pick between `stdio` and an HTTP transport entry, and how a per-user URL is expressed.
- Whether `server.json` must ship inside the npm tarball: the quickstart validates `mcpName` in `package.json` only, so `files` in `package.json` is expected to stay unchanged; confirm at first publish.
- Whether the same version can ever be re-published: a third-party source says no; the official docs were not found to state it. Treat each `publish` as final.

## What listing gives and does not give

- Gives: a namespace-verified metadata record, API-searchable, ingested by downstream catalogs (third-party claim), and a canonical URL to cite.
- Does not give: a place in Claude's Connectors Directory or ChatGPT's plugin directory; a review; traffic. The Registry is a metadata feed and is still in preview (breaking changes or data resets possible).
- Discoverability by LLM browsing depends on server-rendered docs, question-shaped headings, `Organization` schema with `alternateName` and `sameAs` on `akimcp.top` (`seo.B`), not on this listing.

## Deferred channels and why

| Channel | Blocker for akimcp as it stands |
|---|---|
| Claude Connectors Directory (`claude.ai/directory/manage`) | Needs one production Streamable HTTP endpoint with OAuth 2.1 + PKCE, annotated tools, docs and a privacy policy; akimcp has one URL per user. Local MCPB is no longer accepted. |
| OpenAI plugin portal (ChatGPT and Codex) | Needs one production HTTPS URL, domain verification at `/.well-known/openai-apps-challenge`, verified publisher identity, tool annotations with justifications, test cases. Local or temporary tunnels are refused. |
| Gemini, Grok | No submission channel found; they already connect as custom connectors. |

Reopen when a hosted multi-tenant or narrow-scope remote variant of akimcp exists.

## Sources (read 2026-09-28)

- Registry quickstart, fetched in full: `https://modelcontextprotocol.io/registry/quickstart` (`mcpName`, `server.json`, `mcp-publisher`, GitHub auth namespace rule).
- Claude directory submission and OpenAI plugin submission: search-result snippets only, pages not fetched: `https://claude.com/docs/connectors/building/submission`, `https://developers.openai.com/plugins/deploy/submission`.
- Third-party guides for downstream ingestion (PulseMCP, Smithery, Glama): unverified against vendor docs.

## Verification checklist

- [ ] `package.json` `mcpName` equals `server.json` `name`; `server.json` versions equal the published npm version.
- [ ] `npm view @akinet/akimcp@<version> mcpName` returns the chosen name.
- [ ] The `curl` search against the Registry API returns the record.
- [ ] Transport open question resolved and `server.json` matches what `npx @akinet/akimcp` actually starts.
- [ ] One week later: PulseMCP, Smithery, Glama listing state recorded in this doc or its successor.

## Scope

This plan does not edit `package.json`, create `server.json`, publish to npm or the Registry, commit, or push. It schedules that later work.
