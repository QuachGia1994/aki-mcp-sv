# claude.ai — Add custom connector (dialog fields)

Ghi lại vì nó quyết định cơ chế auth phải dùng.

## Field có sẵn
- **Name** — tên hiển thị trong danh sách connector.
- **Remote MCP server URL** — bắt buộc, dạng `https://mcp.example.com/mcp`.
- **Advanced settings** (optional):
  - **OAuth Client ID**
  - **OAuth Client Secret**
- **Request headers** (beta, chưa chắc có sẵn cho tài khoản cá nhân) — nhập `Authorization: Bearer <token>` trực tiếp, không cần OAuth. Xem `docs/ref/oauth-research-2026-08-07.md`.

## Hệ quả — đã đổi so với lần đọc đầu

Lần đầu đọc dialog (trước 2026-08-07), tưởng "không có field header → phải nhét token vào URL". **Sai với thực tế vận hành**: dù không điền OAuth Client ID/Secret, claude.ai vẫn tự động thử Dynamic Client Registration (DCR) trước khi kết nối, và lỗi ngay nếu server không trả lời đúng handshake OAuth — token-in-URL không né được bước này. Xác nhận bằng test thật + GitHub issue công khai của Anthropic (`anthropics/claude-ai-mcp#457`) — chi tiết đầy đủ: `docs/ref/oauth-research-2026-08-07.md`.

**Quyết định hiện tại**: dùng OAuth Client ID/Secret tự cấp (field có sẵn, không cần beta) + tự dựng authorization server tối giản, bỏ qua DCR bằng cách không quảng cáo `registration_endpoint`. Xem `scripts/oauth.js`, `docs/ref/security-model.md`.

## Cross-references
- `docs/ref/oauth-research-2026-08-07.md` — research đầy đủ, ngày giờ, link nguồn
- `docs/ref/security-model.md` — mô hình bảo mật OAuth hiện tại
- `docs/plan/init.md` — quyết định kiến trúc
