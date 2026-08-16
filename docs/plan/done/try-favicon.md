# Try MCP-provided icon

## Status

Done — closed by a different fix, not by this experiment. A custom subdomain ingress shipped (`docs/plan/cloudflare-tunnel-ingress.md`), and Claude fetches the favicon from that top-level domain directly. The `serverInfo.icons` path below was never tested.

## Goal

Find out whether Claude's connector UI can use the MCP server's declared icon, avoiding the current `*.ts.net` favicon limitation without changing the zero-config Tailscale Funnel architecture.

## Why this is worth trying

The repo already serves `/favicon.ico` and other favicon assets, but the documented Claude path uses Google's favicon service with the tailnet apex rather than the per-machine Funnel hostname. That makes the local HTTP favicon ineffective for the current UI.

The MCP protocol also exposes server metadata that can include `serverInfo.icons`. The repo does not currently provide it. This is a cheap experiment before considering any relay, custom-domain, or tunnel-provider change.

## Hypothesis

If Claude consumes MCP `serverInfo.icons` for connector branding, returning the existing public icon URL from the `initialize` response may make the connector display the AkiTao icon even though the public endpoint remains `*.ts.net`.

## Minimal change to test

Add an `icons` entry to the server information returned by the MCP `initialize` response, pointing at the existing public PNG icon, for example:

```json
{
  "serverInfo": {
    "name": "AkiTao",
    "version": "...",
    "icons": [
      {
        "src": "https://<current-funnel-host>/favicon/icon-192.png",
        "mimeType": "image/png",
        "sizes": ["192x192"]
      }
    ]
  }
}
```

Use the actual generated public origin at runtime; do not hard-code a machine-specific Funnel hostname.

## Test

1. Start the normal `aki-mcp-sv` flow; keep Tailscale Funnel and zero-config behavior unchanged.
2. Connect a fresh Claude connector after the metadata change.
3. Check the connector icon immediately after creation and after reopening/reloading the connector UI.
4. Verify that the icon URL itself is reachable from the public Internet, not only through the local tailnet path.
5. If practical, repeat with a newly generated Funnel hostname to distinguish cached branding from metadata behavior.

## Success criteria

Claude displays the AkiTao icon based on the MCP-provided metadata, with no custom domain, Cloudflare account, customer configuration, or additional relay.

## Failure criteria

Claude continues to display the letter/default icon while the MCP metadata and icon URL are valid. Record the observed behavior and response path, then stop: do not add infrastructure solely for this cosmetic issue unless a later client-side change creates a better opportunity.

## Non-goals

- Replacing Tailscale Funnel.
- Requiring customers to own a domain.
- Adding Cloudflare Access or another authentication layer.
- Building a favicon proxy/relay before confirming that the MCP metadata path is ignored.

## Decision

This is a deliberately small experiment. If `serverInfo.icons` is ignored by Claude's connector UI, treat the icon limitation as an external client/hostname limitation and keep the existing zero-config architecture.
