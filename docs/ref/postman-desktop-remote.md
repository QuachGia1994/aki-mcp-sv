# Postman Desktop remote control from iPhone

Updated 2026-09-07 — preferred operator path is Cloudflare One private-network RDP; Postman Desktop, Aki MCP, repo/files/shell/build/test remain on the Windows PC.

## Contract

This workflow is intentionally desktop-only:

`iPhone → remote Windows session → Postman Desktop → AI Chat → Aki MCP or subagent shell → Windows repo/files/shell/build/test`.

The iPhone is only the remote-control surface. Do not replace Postman Desktop with Postman Web/Cloud Agent, do not require linked project folders or cloud workspace state, and do not move local execution onto the phone. Multiple Postman Desktop windows/chats are allowed. When a chat becomes long or laggy, summarize the current session into a compact handoff prompt and continue in a new Desktop chat.

## Why Cloudflare One private RDP is the default

Cloudflare Tunnel can expose non-HTTP private applications through a private hostname while the iPhone connects through the Cloudflare One Client/WARP. Current Cloudflare One supports private-hostname routing on iOS, and Access can secure private hostname/IP applications on arbitrary ports/protocols, including RDP, with identity policy and MFA. This avoids opening TCP 3389 on the router or publishing an unauthenticated RDP listener to the Internet.

The older published-RDP pattern (`cloudflared access rdp --hostname ...`) requires `cloudflared` on the client side. That is useful for desktop clients but is not the primary iPhone path. For iPhone, use the Cloudflare One Client/WARP as the on-ramp and Microsoft Windows App as the RDP client.

## Recommended topology

```text
iPhone
  ├─ Cloudflare One Client (Traffic + DNS, enrolled to Zero Trust)
  └─ Windows App (RDP client)
        ↓
Cloudflare Gateway + Access policy/MFA
        ↓
Cloudflare Tunnel (outbound-only connector on Windows/private network)
        ↓
remote.oakgatekeeper.uk:3389 (private hostname application)
        ↓
Windows interactive session
        ↓
Postman Desktop → Aki MCP / subagent shell → local repositories
```

Aki's public MCP ingress is a different plane. `aki.oakgatekeeper.uk`/`PUBLIC_ORIGIN` may continue to terminate at Cloudflare and forward to the OAuth-protected MCP server. RDP should remain a Cloudflare One private application. Do not reuse Aki OAuth tokens/passphrase as Windows or Cloudflare remote-desktop credentials.

## Windows prerequisites

1. The Windows host edition must support incoming Remote Desktop (Windows Pro/Enterprise/Education/Server; Home cannot act as an RDP host).
2. Enable **Settings → System → Remote Desktop** and keep Network Level Authentication enabled unless a reproduced compatibility issue requires otherwise.
3. Use a Windows account with a strong password and explicit Remote Desktop permission.
4. Do not create router/NAT port-forwarding for 3389. The tunnel is the ingress path.
5. To preserve the existing Postman session, connect with the same Windows account that already owns the Postman processes. When finished, disconnect the RDP client rather than signing out of Windows.

## Cloudflare setup

### 1. Reuse or create the tunnel

Prefer the existing healthy `cloudflared` tunnel on the Windows/private-network side. The connector is outbound-only; no inbound firewall/NAT opening is required for Cloudflare Tunnel itself.

### 2. Add a private hostname route

In Cloudflare Zero Trust: **Networking → Tunnels → <tunnel> → Routes → Add route → Private hostname**. Use a hostname such as `remote.oakgatekeeper.uk`.

The `cloudflared` host must be able to resolve that hostname to the Windows private address. Use the host's system resolver/hosts file when that is sufficient; otherwise use a private DNS server plus a Gateway resolver policy. Do not add a public DNS record pointing directly at the Windows private address and do not publish an RDP origin as a normal Internet service.

### 3. Configure the iPhone on-ramp

Install Cloudflare One Client on iPhone, enroll it into the same Zero Trust organization, and use **Traffic and DNS** mode. Private-hostname routing requires the Cloudflare Gateway proxy and split-tunnel/DNS settings that send the private hostname and Cloudflare initial-resolved IP range through WARP.

When the route is working, querying the private hostname from an enrolled client should resolve through Cloudflare Gateway to an initial-resolved IP rather than ordinary public DNS.

### 4. Protect the RDP application with Access

Create a self-hosted **private** Access application for `remote.oakgatekeeper.uk` on port `3389`.

Recommended policy:

- deny by default;
- Allow only the owner's identity/account;
- enable **Authenticate with Cloudflare One Client** because RDP cannot follow a browser `302` login flow;
- require MFA (independent MFA or IdP-reported MFA, depending on the configured identity provider);
- choose a bounded client/application session duration appropriate for a personal remote-administration surface.

Access/MFA controls whether a new connection may be established. Cloudflare does not terminate an already-active RDP session merely because the Access application session expires.

### 5. Connect from iPhone

Install Microsoft **Windows App** on iOS/iPadOS. Add a Remote PC whose PC name is the private hostname (for example `remote.oakgatekeeper.uk`) and use the Windows account permitted for RDP. Keep the Cloudflare One Client connected while using the private hostname.

## Preserve Postman Desktop state

Remote access must not become a reason to restart Postman. If Postman is already running, connect to the same Windows user session and use the existing windows. Windows client editions support a single interactive user session; a remote connection may lock/transfer the console view, but disconnecting should leave the Windows session and its applications running.

If the remote desktop looks like a different/new Windows session, verify the logged-in user/session before launching another Postman instance. Avoid signing out, rebooting, or killing `Postman.exe` unless a failure specifically requires it.

## Postman AI Chat operating rules

- Use Postman Desktop from `postman.com/download`; do not shift the workflow to Postman Web.
- AI Chat is the primary Postman feature; project files remain reachable through Aki MCP or the explicitly requested `dùng subagent shell` path.
- Do not link project folders merely to give AI access to local code, and do not make the workflow depend on a Postman team/workspace that may change.
- Multiple Desktop windows/chats may run in parallel.
- When a chat becomes long/laggy, ask it to summarize the current goal, decisions, changes, tests, blockers, and next step into a new-chat prompt, then continue in a fresh Desktop chat.

## End-to-end verification

A real green check requires all of these:

1. Windows RDP is enabled and no public/router 3389 exposure exists.
2. `cloudflared` tunnel reports healthy/connected.
3. iPhone Cloudflare One Client is enrolled and connected.
4. `remote.oakgatekeeper.uk` resolves through the Cloudflare private-hostname path.
5. Access rejects an unauthorized identity and allows the owner after required authentication/MFA.
6. Windows App reaches the same Windows user session that already owns Postman.
7. Existing Postman Desktop windows/chats are still present.
8. In Postman Desktop AI Chat, a harmless Aki MCP read call can read a known repo/file on Windows.
9. If requested, the same chat can use the subagent-shell path for a harmless local read/diagnostic command.
10. Disconnect the iPhone remote session and confirm Postman Desktop + Aki MCP remain running on Windows.

## Current primary references

- Cloudflare One private networks: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/
- Cloudflare private hostname routing: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/connect-private-hostname/
- Cloudflare Access private IP/hostname apps: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/self-hosted-private-app/
- Cloudflare MFA: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/
- Cloudflare One Client manual deployment (iOS enrollment): https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/deployment/manual-deployment/
- Microsoft Windows App remote PC: https://learn.microsoft.com/windows-app/get-started-connect-devices-desktops-apps
