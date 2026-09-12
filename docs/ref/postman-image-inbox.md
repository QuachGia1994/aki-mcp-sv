# Postman image inbox + OpenCode vision

Use this when Postman Desktop Agent Mode needs to inspect a screenshot/photo but the chat UI has no reliable direct image upload.

The inbox is only local staging. The actual visual analysis is done by OpenCode, and Aki returns plain text to Postman.

## Owner workflow

1. Drop the image into the local inbox folder. On the owner's current Windows setup: `D:\LacViet\Postman-Image-Inbox`.
2. In Postman Desktop AI Chat say `xem ảnh mới nhất`, `phân tích ảnh vừa gửi`, or name the exact file.
3. Aki calls `local__vision_analyze`. With no `name`, it selects the newest supported direct-child image; with `name`, it resolves only that exact basename.
4. Aki starts a temporary `opencode serve --pure` instance bound to `127.0.0.1` with a random per-run Basic Auth password, sends the image as a real image attachment with its MIME type, waits for the vision response, then returns only text to Postman.
5. The default model is `opencode/muse-spark-1.3-contributor-free`. It was materially faster than MiMo in the owner's real screenshot smoke while remaining zero-cost and vision-capable. Override it with `AKI_OPENCODE_VISION_MODEL=provider/model` if needed.

`local__image_inbox` is still available for `list` and raw MCP image output, but Postman Agent Mode should use `local__vision_analyze` for actual visual understanding.

## Why the OpenCode bridge exists

The previous implementation returned MCP `type:image` content directly. That is protocol-valid, but the owner's real Postman Agent Mode workflow did not reliably feed that tool-result image into model vision. A folder plus a raw image tool therefore did not solve the user's problem.

The bridge changes the boundary:

`Postman text request -> Aki vision_analyze -> OpenCode vision model -> plain text -> Postman`

Postman only needs to consume ordinary MCP text, while OpenCode handles the multimodal request.

## OpenCode requirements

- OpenCode CLI must be installed on the Windows machine.
- Resolution order for the executable:
  1. `AKI_OPENCODE_EXE`
  2. `%USERPROFILE%\.bun\bin\opencode.exe` when present
  3. `opencode.exe` from `PATH`
- The selected model must support image attachments.
- Default timeout is 90 seconds. `AKI_OPENCODE_VISION_TIMEOUT_MS` may override it; the bridge clamps effective waits to a bounded maximum.
- The OpenCode server is launched with `--pure`, bound only to loopback, protected by a random per-run `OPENCODE_SERVER_PASSWORD`, and receives `tools: {}` for the image request.

## Folder resolution

Aki stays OS-agnostic. `AKI_IMAGE_INBOX_DIR` may explicitly set the inbox. Without it, Aki chooses the broadest configured allowed folder that contains the running repo and uses its `Postman-Image-Inbox` child. With the owner's allowed root `D:\LacViet` and repo `D:\LacViet\aki-mcp-sv`, that resolves to `D:\LacViet\Postman-Image-Inbox`.

## Safety and limits

- `vision_analyze` never gives OpenCode arbitrary filesystem image access; the file must first resolve as a safe direct child of the inbox.
- Only direct-child basenames are accepted. Absolute paths, `..`, nested paths, and symlink/junction escapes are rejected.
- MIME is sniffed from file bytes instead of trusting the extension.
- Maximum one-image payload: 8 MiB before base64 expansion.
- `vision_analyze` accepts PNG, JPEG, WebP, and GIF, matching OpenCode image attachment support.
- Raw `image_inbox` also recognizes HEIC/HEIF, but those formats are rejected by `vision_analyze`; convert them to PNG/JPEG/WebP/GIF first.
- The temporary OpenCode server binds to `127.0.0.1` only and uses an ephemeral random Basic Auth password that is never returned to Postman.
- The request disables model tools and uses a fixed system instruction to analyze the attachment and return factual text. Passwords, API keys, tokens, invite codes, session IDs, and similar values are summarized as present instead of copied back unless the owner explicitly asks for the exact value.
- On Windows, the bridge terminates the OpenCode process tree it spawned after the request; it does not kill unrelated OpenCode processes.

## Tools

### `local__vision_analyze`

Preferred Postman tool for seeing images.

Inputs:
- `name` optional: exact direct-child filename. Omit for newest image.
- `prompt` optional: what to inspect. Omit for general UI/text/error analysis.

Output: one MCP text block containing the image name, OpenCode model, and visual analysis.

### `local__image_inbox`

Raw/staging helper kept for compatibility.

Actions:
- `list`: list supported direct-child images.
- `latest`: return newest raw MCP image content.
- `read`: return a named raw MCP image content block.

For Postman Agent Mode visual reasoning, prefer `vision_analyze`.

## Verification

Real smoke tests on `aki-watch_rk3zwwMtKn.png` proved the image reaches model vision rather than being treated as text/base64. `mimo-v2.5-free` correctly read the Aki Watch/Postman join panel in about 62.6 seconds; `muse-spark-1.3-contributor-free` returned the same key visible state in about 21.6 seconds, so Muse is the default.

References:
- https://opencode.ai/docs/server/
- https://opencode.ai/v2/docs/attachments
- https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- https://learning.postman.com/docs/use/send-requests/protocols/mcp-requests/export-mcp-server-config
