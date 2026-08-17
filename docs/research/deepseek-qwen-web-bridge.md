# DeepSeek and Qwen web bridge feasibility

**Start time:** 2026-08-17 08:01 +07:00

## Initial purpose

After adding the Kimi Web K3 -> Cloudflare D1 -> Aki transport, check whether DeepSeek Web and Qwen Studio can reach Aki from their web quota through either a native custom MCP connector or a web-side tool/plugin capable of using the same D1 mailbox. The important distinction is web product capability versus API/CLI agent capability: an API or coding CLI path does not satisfy the goal if it moves usage away from the normal web product.

## Strategy

Use current first-party DeepSeek and Qwen product/API documentation only. Separate three questions for each provider: (1) does the web product expose custom/user MCP, (2) does the web product expose a sufficiently general external tool/plugin that could write/read the D1 mailbox, and (3) does a separate API/CLI agent support MCP even if that does not solve the web-quota goal.

## Checklist

- [x] Check current DeepSeek product and API tool documentation.
- [x] Check DeepSeek's Anthropic-compatible API treatment of `mcp_servers`.
- [x] Check current Qwen Studio web tool claims.
- [x] Check Qwen Code remote MCP/OAuth support and current authentication model.
- [x] Separate confirmed web capability from SDK/CLI capability.

## Result

### DeepSeek Web

No first-party documentation found in this pass exposes a user-configurable custom MCP or plugin/connector surface in DeepSeek Chat. The current web/app product is documented with built-in capabilities such as web search, file handling, DeepThink/Expert/Instant modes, while the developer API separately supports function/tool calls.

The API route is real but is not a substitute for web usage. DeepSeek's OpenAI-style Chat Completions API supports function tools. Its Anthropic-compatible API explicitly marks the `mcp_servers` field as **Ignored**, while normal tool definitions are supported. DeepSeek also documents using V4 behind third-party coding agents such as Claude Code and GitHub Copilot, where those host agents keep their own MCP/tool layer. That is an API/agent path, not DeepSeek Web calling Aki.

**Verdict:** no implementable DeepSeek-Web -> Aki bridge is confirmed today. Reusing the D1 bridge would require a future DeepSeek Web plugin/tool that can perform arbitrary HTTP/API work or at least read/write a shared cloud datastore. A manual UI/tool inventory is worth repeating if DeepSeek adds a plugin marketplace or external-app feature.

### Qwen Studio web

Qwen Studio has stronger built-in agent/tool behavior than DeepSeek Web: Qwen's first-party material says current chat models can autonomously use built-in Search, Memory, and Code Interpreter, and the Qwen Studio model descriptions say models can invoke tools during normal conversations. A current first-party Qwen Studio route also exposes `qwen3.8-max-preview` in Web Dev mode, matching the model family being evaluated here. This pass still found no first-party documentation exposing a user-configurable remote MCP entry or arbitrary custom connector inside the Qwen Studio web product itself.

The decisive live probe came from the current Qwen Web session on 2026-08-17: `code_interpreter` executed Python `requests.post(...)` to Cloudflare's API endpoint with an intentionally invalid bearer token, JSON body, and custom headers, and received Cloudflare's structured HTTP `401` authentication response with no sandbox exception. That is direct observed evidence that Qwen Web's code interpreter has outbound HTTPS, POST, JSON, and custom Authorization-header capability. It is enough to call a purpose-built HTTPS Worker bridge without moving inference to Qwen Code/API quota.

Qwen's non-web agent stack also supports MCP well. Qwen-Agent accepts `mcpServers`, and Qwen Code supports `stdio`, legacy SSE, and recommended remote Streamable HTTP MCP plus OAuth 2.0. Qwen Code can therefore point directly at Aki's `/mcp` endpoint, but it is no longer needed for this use case; Qwen Web can use its own code interpreter transport instead. Qwen Code's old Qwen OAuth free tier was discontinued on 2026-04-15, so it remains a separate quota path.

**Verdict:** Qwen Web -> Aki is transport-feasible and implementation is now built as `cloudflare/qwen-bridge-worker`: Qwen calls a narrow bearer-authenticated Worker, the Worker uses a D1 binding, and local Aki consumes the existing `aki_bridge_tasks` mailbox. Live end-to-end status remains unverified until the Worker/D1 are deployed and one real task completes.

## Verification

Findings were cross-checked against current first-party sources:

- DeepSeek Tool Calls: https://api-docs.deepseek.com/guides/tool_calls
- DeepSeek Anthropic API compatibility (`mcp_servers` ignored): https://api-docs.deepseek.com/guides/anthropic_api
- DeepSeek V4 web/API announcement: https://api-docs.deepseek.com/news/news260424/
- DeepSeek product home: https://www.deepseek.com/en/
- Qwen Studio / Qwen3-Max-Thinking adaptive built-in tools: https://qwen.ai/blog?id=qwen3-max-thinking
- Qwen Studio product: https://qwen.ai/qwenchat
- Qwen Studio Qwen3.8 Max Preview Web Dev route: https://chat.qwen.ai/?inputFeature=web_dev&models=qwen3.8-max-preview
- Qwen Code MCP guide: https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/
- Qwen Code authentication: https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/
- Qwen3 agentic MCP via Qwen-Agent: https://qwenlm.github.io/blog/qwen3/

No claim of absence is treated as proof that a hidden/experimental UI does not exist. The web verdicts are intentionally phrased as "not confirmed in first-party documentation" and require a live UI inventory if the product exposes new tools after this research date.

## Decision

**Action:** keep one local D1 mailbox implementation in `scripts/d1-bridge.js`. Kimi reaches it through the Cloudflare plugin's Management API; Qwen reaches the same mailbox through the narrow `cloudflare/qwen-bridge-worker` HTTPS ingress so no Cloudflare API token is exposed to Qwen. DeepSeek Web remains **No action** until an external-app/plugin or outbound-code surface is confirmed. Cross-references: `docs/ref/kimi-web-d1-bridge.md`, `docs/ref/qwen-web-worker-bridge.md`, `docs/feat/tools.md`.

## Live verification addendum — 2026-08-17

The initial research used “Qwen Web” too broadly. Live testing showed two different execution environments:

- **Qwen Coder Web (`coder.qwen.ai`) — verified.** The deployed Worker/D1/Aki path completed a real `filesystem__read_text_file` call returning the installed akidevrule commit and a real `local__run_cmd` call returning the local `aki-mcp-sv` git status.
- **Qwen Chat (`chat.qwen.ai`) — not verified for this path.** Its Python sandbox reported that the network was unreachable for the task-submit request. Its web extraction tool could reach the Worker's public endpoint with GET, but that tool does not provide the POST operation the bridge requires.

Therefore the implementation target is now named **Qwen Coder Web**, not generic Qwen Web. The earlier transport probe is retained above as the event record that led to the implementation; this addendum narrows the product surface based on the later live evidence.
