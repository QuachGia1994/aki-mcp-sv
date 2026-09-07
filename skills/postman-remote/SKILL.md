---
name: aki-postman-remote
description: Preserve a Postman Desktop-only workflow when controlling the Windows development machine remotely from iPhone. Keep Postman Desktop, Aki MCP, shell, repo, build, and test execution on Windows; prefer Cloudflare One private-network RDP with WARP + Access/MFA rather than Postman Web, cloud workspaces, client-side cloudflared on iPhone, or publicly exposed RDP.
---

# Aki Postman Remote

Use this skill for Postman Desktop AI Chat, remote Windows control from iPhone/iPad, Cloudflare Tunnel/Access/WARP, RDP, preserving running Postman windows, or requests that explicitly reject Postman Web/cloud-folder workflows.

## Fixed operating model

The phone is only a remote-control surface. The execution chain remains:

`iPhone → remote Windows session → Postman Desktop → AI Chat → Aki MCP or subagent shell → Windows repo/files/shell/build/test`.

Do not move the workflow into Postman Web, Cloud Agent, linked folders, synced workspaces, or another cloud execution host unless the user explicitly asks for that migration. Multiple Postman Desktop windows/chats are valid. When a chat becomes long or laggy, summarize the current session into a compact handoff prompt and continue in a new Desktop chat.

## Postman behavior

- Prefer Postman Desktop from `postman.com/download`; do not tell the user to switch to the web app.
- Treat AI Chat as the primary Postman feature. Do not require project folders or workspace/cloud state just to let the agent reach local code.
- For local-machine actions, use Aki MCP first when connected. If the user explicitly says `dùng subagent shell`, the Postman agent may use its native/subagent shell path instead.
- Preserve existing Postman windows and chat state. Do not kill/relaunch Postman merely to establish remote access. If a restart is genuinely required, state why and protect session state first.
- Aki MCP remains a local Windows service. Remote-control setup must not change the repo/files/shell execution host to the phone.

## Preferred iPhone → Windows path

Prefer Cloudflare One private-network access over a public RDP hostname:

1. Windows must support incoming RDP and Remote Desktop must be enabled. Keep Network Level Authentication enabled unless a reproduced client-compatibility problem proves it cannot be used.
2. Keep `cloudflared` on the Windows/private-network side as the outbound-only tunnel connector. Reuse an existing healthy tunnel when possible instead of creating a second tunnel for the same machine.
3. Add a **private hostname route** for a name such as `remote.oakgatekeeper.uk`. The Windows/cloudflared host must resolve that hostname to the Windows private address through its system resolver, hosts file, or a Cloudflare Gateway resolver policy.
4. Enroll the iPhone in the same Cloudflare Zero Trust organization using the Cloudflare One Client in Traffic and DNS mode. Ensure split-tunnel/local-domain-fallback settings allow the private hostname and Cloudflare initial-resolved IP range to flow through WARP.
5. Protect `remote.oakgatekeeper.uk:3389` with a self-hosted **private** Access application. Prefer `Authenticate with Cloudflare One Client`, an identity allow policy scoped to the owner, and MFA. Deny-by-default remains the baseline.
6. On iPhone, use Microsoft Windows App to connect to the private hostname. Do not open TCP 3389 on the router or publish it directly to the Internet.

Cloudflare's published-RDP pattern that requires `cloudflared access rdp` on the client is a desktop-client fallback, not the primary iPhone path. iPhone should use the Cloudflare One Client/WARP private-network route instead.

## Session preservation

Windows client editions normally allow one interactive user session. Connect with the same Windows account that already owns the Postman processes so the existing desktop session/apps are preserved. Disconnect the RDP client when done; do not sign out unless the user explicitly wants the Windows session terminated.

If reconnecting appears to produce a different desktop/session, stop before launching another Postman copy. Check the Windows user/session first so remote access does not fork the operator state the user wanted to preserve.

## Security boundary

The remote-desktop control plane is separate from Aki's public MCP ingress. Aki may still expose its OAuth-protected MCP endpoint through `aki.oakgatekeeper.uk`/`PUBLIC_ORIGIN`, while RDP stays a Cloudflare One private application. Do not reuse Aki bearer tokens, OAuth client credentials, or the Aki passphrase as Windows/Cloudflare remote-desktop credentials.

Never expose RDP directly to the Internet, never place Cloudflare API tokens in repo docs/config, and never weaken Windows/Cloudflare auth merely to make the first connection easier. Access/MFA, Windows credentials, and Aki OAuth are independent gates.

## Verification

Do not call the setup complete from config alone. Verify the real path in order:

1. Windows RDP service enabled and listening only as expected; no router/public 3389 exposure.
2. Existing `cloudflared` tunnel healthy.
3. The private hostname resolves through the iPhone's Cloudflare One path to a Gateway initial-resolved IP, not ordinary public DNS.
4. Access policy denies an unauthenticated/unapproved user and accepts the authorized owner after MFA/Cloudflare One authentication.
5. Windows App reaches the existing Windows user session.
6. Existing Postman Desktop windows remain present.
7. In a Postman Desktop AI Chat, call one harmless Aki MCP read tool against a known repo, then one harmless shell/read command if the workflow requires shell.
8. Disconnect the phone session and confirm Postman/Aki continue running on Windows.

For implementation changes inside Aki, also apply `../anti-vibecoding/SKILL.md`; for Cloudflare/Aki security-risk review, `../strix/SKILL.md` owns severity/evidence classification.
