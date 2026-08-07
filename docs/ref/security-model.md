# Mô hình bảo mật — OAuth 2.1 tối giản (DCR bị bỏ qua)

Cập nhật 2026-08-07 — thay cho bản token-in-URL trước đó, sau khi phát hiện token-in-URL đâm vào bug OAuth-DCR của claude.ai (chi tiết + link nguồn: `docs/ref/oauth-research-2026-08-07.md`).

## Kiến trúc auth hiện tại

```
claude.ai
   │  GET /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server
   │  (khám phá endpoint, không cần đăng ký — không có /register)
   ▼
gatekeeper.js  ── /authorize  → trang xác nhận, cần đúng passphrase (data/.token)
               ── /token      → đổi code (PKCE S256) lấy access + refresh token
               ── /mcp        → bắt buộc `Authorization: Bearer <access_token>` hợp lệ
                                  sai/thiếu → 401 + WWW-Authenticate, đúng → forward mcp-hub
```

`scripts/oauth.js` giữ toàn bộ state (auth code, access token, refresh token) **in-memory** — không có DB, không persist qua restart.

## Vì sao bỏ qua Dynamic Client Registration (DCR)

claude.ai mặc định thử tự đăng ký client (`POST /register`) trước khi kết nối — server này không có endpoint đó, và metadata `/.well-known/oauth-authorization-server` **cố ý** không quảng cáo `registration_endpoint`. Thay vào đó, `client_id`/`client_secret` được sinh 1 lần (`data/.oauth-client.json`), in ra lúc `npm start`, dán tay vào Advanced settings của dialog — đúng cơ chế "pre-registered client credentials" mà tài liệu Anthropic công nhận là hợp lệ để né DCR hoàn toàn.

## 2 lớp thật sự chặn truy cập trái phép

1. **Passphrase ở `/authorize`** (`data/.token`, 10 ký tự ngẫu nhiên từ bảng chữ 32 ký tự không nhầm lẫn — `abcdefghjkmnpqrstuvwxyz23456789`, ~50-bit entropy) — ai không biết passphrase không duyệt được bước consent, không có auth code nào được cấp. Rút gọn từ hex 256-bit ban đầu ngày 2026-08-07 để dễ gõ/copy-paste tay hơn — entropy 50-bit vẫn đủ để giữ nguyên lý luận "không cần rate-limit" bên dưới. **Không đổi thành nút Approve trần không kèm passphrase**: đã cân nhắc và loại — POST `/authorize` là endpoint public qua Funnel, request giả lập (`curl`) gửi đúng field như nút bấm thì server không phân biệt được, nên một "nút" không kèm giá trị bí mật không có tác dụng bảo vệ thật nào.
2. **PKCE S256** — access token chỉ cấp cho đúng client đã tạo `code_challenge` khớp `code_verifier` gửi lên `/token`; chặn kẻ chặn được authorization code giữa đường (không có verifier thì code vô dụng).

`mcp-hub` thật vẫn chỉ nghe loopback `19999`, `/api/*` không bao giờ được forward — không đổi so với thiết kế gốc.

## Giới hạn thật của cách làm này

- **Không rotate refresh token** — chấp nhận được vì đây là confidential client (có client_secret), không phải public client theo DCR/CIMD (rule rotation trong spec MCP chỉ bắt buộc cho public client).
- **Restart `npm start` = mất hết session đã cấp** — access/refresh token chỉ ở RAM. claude.ai sẽ cần "Connect" lại. Đánh đổi chấp nhận được cho MVP 1 người dùng, chạy foreground chủ động.
- **Không rate-limit `/authorize`** — chấp nhận vì passphrase 256-bit khiến brute-force bất khả thi, cùng lý luận entropy đã áp dụng cho token-in-URL trước đây.

## Cross-references
- `docs/ref/oauth-research-2026-08-07.md` — research đầy đủ dẫn tới quyết định này, link nguồn
- `docs/ref/claude-connector.md` — field thật của dialog claude.ai
- `docs/plan/init.md` — quyết định kiến trúc gốc
- `scripts/oauth.js`, `scripts/gatekeeper.js` — implementation thật
