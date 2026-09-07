# Postman image inbox

Use this when Postman Desktop Agent Mode needs to inspect a screenshot/photo but the chat UI has no direct image upload.

## Owner workflow

1. Drop the image into the local inbox folder. On the owner's current Windows setup: `D:\LacViet\Postman-Image-Inbox`.
2. In Postman Desktop AI Chat say `xem ảnh mới nhất`, `phân tích ảnh vừa gửi`, or name the exact file.
3. Aki calls `local__image_inbox`. `latest` returns the newest supported direct-child image, `read` returns a named basename, and `list` is only for disambiguation.
4. The tool returns an MCP-native image content block (`type: image`, base64 data, MIME type), so the selected Postman model can analyze the visual itself. No OCR or separate upload service is used by Aki.

## Folder resolution

Aki stays OS-agnostic. `AKI_IMAGE_INBOX_DIR` may explicitly set the inbox. Without it, Aki chooses the broadest configured allowed folder that contains the running repo and uses its `Postman-Image-Inbox` child. With the owner's allowed root `D:\LacViet` and repo `D:\LacViet\aki-mcp-sv`, that resolves to `D:\LacViet\Postman-Image-Inbox`.

## Safety and limits

- Read-only MCP tool; it never writes, edits, deletes, uploads, or watches files.
- Only direct-child basenames are accepted. Absolute paths, `..`, nested paths, and symlink/junction escapes are rejected.
- MIME is sniffed from file bytes instead of trusting the extension.
- Supported raster content: PNG, JPEG, WebP, GIF, HEIC, HEIF. SVG is rejected.
- Maximum one-image payload: 8 MiB before base64 expansion.
- Subfolders and unsupported files do not appear in `list`.
- HEIC/HEIF is passed through as MCP image content; whether it is visually understood depends on the Postman client and selected model. Use PNG/JPEG for the most portable path.

## Compatibility boundary

MCP itself explicitly supports image content in tool results, and the official TypeScript SDK documents the same return shape. Postman documents Agent Mode MCP-server integration, but its public docs do not promise support for every multimodal tool-result type. Therefore source/protocol tests can prove Aki emits a valid image result, while a real Postman Desktop call is the final client-compatibility check.

References:
- https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- https://ts.sdk.modelcontextprotocol.io/server
- https://learning.postman.com/docs/use/send-requests/protocols/mcp-requests/export-mcp-server-config
