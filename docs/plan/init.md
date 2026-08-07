# Init — mở MCP cho AI ngoài internet

## Mục tiêu tối thượng
Mở MCP server để các dịch vụ AI bên ngoài (đầu tiên: claude.ai) tương tác được với máy Mac này từ ngoài internet.

## Ràng buộc bắt buộc
- **1 tiến trình, 1 cổng duy nhất** — không multiplex nhiều service, không thêm gateway/reverse-proxy.
- Bộ tool MCP **tối thiểu** cho tương tác: file (đọc/ghi trong 1 thư mục scope, chọn được mỗi lần khởi chạy) + bash (**chỉ lệnh READ-ONLY**, whitelist).

## Quyết định kiến trúc

| Vấn đề | Quyết định | Vì sao |
|---|---|---|
| Gộp nhiều MCP server con | `mcp-hub` (nội bộ, cổng `19999`, endpoint `/mcp`) | tự spawn server con qua stdio, gộp tool thành 1 HTTP endpoint |
| Chặn `/api/*` của mcp-hub khỏi internet | `scripts/gatekeeper.js` (tự viết, cổng `9999` — cổng THẬT mà funnel trỏ vào) | **phát hiện:** `mcp-hub` có REST API quản trị (`/api/*`: start/stop/reconfigure) không hề có auth, cùng port với `/mcp`. Forward nguyên port ra funnel = lộ quyền quản trị cho cả internet. Gatekeeper chỉ forward request path đúng `/mcp/<token>`, mọi thứ khác (kể cả `/api/*`) → 404 |
| Auth cho `/mcp` | OAuth 2.1 tối giản (`scripts/oauth.js`), DCR bị bỏ qua — client ID/Secret tự cấp, dán tay vào Advanced settings | **Đổi 2026-08-07**: token-in-URL đâm vào bug thật của claude.ai — nó luôn tự thử Dynamic Client Registration dù để trống OAuth field, lỗi "Couldn't register with sign-in service" (xác nhận qua GitHub issue công khai `anthropics/claude-ai-mcp#457`). Client ID/Secret tự cấp là cách duy nhất né DCR mà không cần field beta. Chi tiết: `docs/ref/oauth-research-2026-08-07.md` |
| Expose ra internet | `tailscale funnel 9999` trỏ vào **gatekeeper**, không trỏ thẳng vào mcp-hub | gatekeeper là điểm chốt an toàn duy nhất; mcp-hub (19999) chỉ nghe trên loopback, không bao giờ lộ trực tiếp |
| Không dùng nginx | loại bỏ, thay bằng script Node ~40 dòng | cùng việc (path-filter + token-check), giữ nhất quán với `shell-mcp.js` đã có, không thêm dependency hệ thống |
| Không dùng `tailscale serve` | loại bỏ | `serve` chỉ public trong phạm vi tailnet; claude.ai không nằm trong tailnet của máy này nên không vào được — bắt buộc phải `funnel` |
| Không dùng `shell-mcp` (npm) cho whitelist | loại bỏ, thay bằng `scripts/shell-mcp.js` tự viết | package `shell-mcp` thật trên npm **không có whitelist** — chỉ có 1 tool `execute` chạy bất kỳ lệnh nào. Whitelist phải tự enforce bằng code (`execFile`, không qua shell, chặn `; & \| ...`) |

## Giới hạn Funnel cần biết
- Miễn phí trên mọi gói Tailscale.
- Chỉ chạy trên 1 trong 3 cổng: `443` / `8443` / `10000` — không public được cổng tùy ý.
- Băng thông có giới hạn nhưng Tailscale không công bố số cụ thể.
- Bật/tắt funnel liên tục (cấp lại chứng chỉ nhiều lần) có thể dính rate limit Let's Encrypt — khóa ~34 giờ. Để funnel chạy ổn định, tránh toggle.

## Permission — quyết định

| Vấn đề | Quyết định | Cơ chế |
|---|---|---|
| Whitelist lệnh shell | **Chỉ lệnh READ-ONLY**: `ls`, `cat`, `pwd`, `find`, `grep`, `head`, `tail`, `wc`, `file`, `stat`, `tree`, `git status/log/diff/show`, `ps`, `df`, `du`, `whoami`, `uname` — không lệnh ghi, không `env` | enforce bằng code trong `scripts/shell-mcp.js`: `execFile` (không qua shell) + chặn ký tự chaining `; & \| \` $ < >` |
| Phạm vi filesystem — chọn linh hoạt mỗi session | **Được ở mức khởi chạy process, KHÔNG ở mức mỗi prompt.** MCP filesystem server chốt root path lúc start (đây là ranh giới bảo mật cố ý của MCP — nếu client tự chọn path mỗi lần gọi tool thì whitelist mất tác dụng, AI có thể xin bất kỳ path nào). Linh hoạt hoá bằng biến môi trường: `MCP_DATA_DIR=/path/khac npm start` — đổi scope mỗi lần khởi chạy, vẫn cố định trong suốt phiên đang chạy. **Đổi 2026-08-07**: default chuyển từ `./data` sang `$HOME` — thư mục duy nhất chắc chắn tồn tại trên mọi máy và chứa code người dùng thật sự muốn Claude với tới; `./data` gần như không dùng trong công việc thực tế. Xem `README.md`. `list_allowed_directories`/`directory_tree` (tool có sẵn của filesystem MCP server) là cơ chế "index" tự động: Claude tự gọi để biết phạm vi + tự khám phá bên trong, không cần index riêng. **Đảo lại về sau**: `~/.claude` được cấp quyền để claude.ai đọc native `CLAUDE.md`/skill router như Claude Code; hệ quả (token, lịch sử chat trong cùng thư mục) ghi rõ ở `README.md` để người dùng tự quyết | default `$HOME` chốt ở `package.json` (`start` script); `mcp-hub.config.json` chỉ đọc `${MCP_DATA_DIR}` trần, không tự có fallback |
| Chạy nền | **Không** — chủ động khởi chạy `npm start` khi cần (foreground, Ctrl+C dừng), không pm2/launchd | thủ công |
| Funnel bật theo project, không cần bật lại mỗi lần | **Tự động qua `npm start`** (`tailscale funnel --bg 9999`, chạy chế độ nền của tailscaled) — cấu hình lưu trong state của `tailscaled` (daemon hệ thống), sống qua cả việc đóng terminal lẫn reboot máy. `start.js` tự check `tailscale funnel status --json` trước, chỉ gọi `--bg` khi cổng chưa bật (idempotent, tránh toggle liên tục dính rate-limit Let's Encrypt). Tắt hẳn bằng `tailscale funnel 9999 off` | `scripts/start.js` gọi tailscale CLI |
Token/OAuth credentials tiện lợi | Passphrase (`data/.token`) + OAuth client ID/Secret (`data/.oauth-client.json`) tự sinh & lưu lần đầu, đọc lại các lần sau | `scripts/start.js`, `scripts/oauth.js` |

## Checklist thực thi
- [x] `package.json` — deps `mcp-hub`, `@modelcontextprotocol/sdk`, `zod`; script `start` → `scripts/start.js`
- [x] `scripts/shell-mcp.js` — tool `run_cmd`, whitelist read-only
- [x] `scripts/oauth.js` — authorization server tối giản (DCR bị bỏ qua, PKCE S256)
- [x] `scripts/gatekeeper.js` — OAuth metadata/authorize/token + reverse-proxy `/mcp` (Bearer-gated)
- [x] `scripts/start.js` — orchestrate mcp-hub (nội bộ 19999) + gatekeeper (public 9999), in URL + client ID/secret
- [x] `mcp-hub.config.json`, `data/`
- [x] Test local (curl, không qua funnel): metadata 200, `/mcp` không bearer → 401, sai path → 404, full flow authorize→token→bearer /mcp → auth pass (502 vì chưa nối mcp-hub, đúng như kỳ vọng), bearer sai → 401
- [x] Đổi từ token-in-URL sau khi test thật trên claude.ai gặp bug DCR — xem `docs/ref/oauth-research-2026-08-07.md`
- [x] `npm start` (bản OAuth mới) — lấy URL + client ID/secret in ra
- [x] Add custom connector trên claude.ai: dán URL + client ID/secret, Connect, duyệt bằng passphrase — `/authorize` chạy đúng (GET 200, POST 302 kèm code hợp lệ)
- [x] Root cause thật đã xác nhận + fix: **Tailscale Funnel desync với control plane** (serve-config "on" cục bộ nhưng không đồng bộ ra hạ tầng công khai) — không phải bug code. Fix: `tailscale funnel --bg 9999` (ép re-push config). Verify bằng `curl --resolve` thẳng vào IP công khai (`dig @8.8.8.8`) — full `/authorize` → `/token` round-trip 200 OK qua đúng đường đi thật. Toàn bộ lịch sử điều tra: `docs/ref/oauth-research-2026-08-07.md`
- [x] OAuth full flow xác nhận chạy đúng trên claude.ai thật sau fix Funnel: `POST /token -> 200`
- [x] Fix tiếp: `mcp-hub` (bản `4.2.1`) dùng transport SSE cũ (`GET /mcp` → sessionId → `POST /messages?sessionId=...`), gatekeeper trước đó chỉ proxy `/mcp` nên chặn nhầm `/messages`. Đã mở route, verify local `202 Accepted`. Chi tiết: `docs/ref/oauth-research-2026-08-07.md` mục "Vòng debug 6"
- [x] Fix tiếp: log thật cho thấy claude.ai không mở `GET /mcp` để lấy `endpoint` SSE, chỉ POST thẳng `/mcp` — không tới được `tools/list` ("no tools available"). Viết `scripts/streamable-bridge.js`: shim Streamable HTTP thật tại `POST /mcp`, bắc cầu nội bộ sang transport cũ của `mcp-hub`. Verify local mô phỏng đúng pattern request thật của claude.ai → `tools/list` trả đủ 15 tools. Chi tiết: `docs/ref/oauth-research-2026-08-07.md` mục "Vòng debug 7"
- [x] Test kết nối thật từ claude.ai (UI) sau fix Streamable HTTP shim — **xác nhận thành công 2026-08-07**: connector kết nối, tools list hiện đủ (14 `filesystem__*` + `shell__run_cmd`). MVP hoàn thành end-to-end.

## Cross-references
- `README.md` — setup và cách chạy
- `docs/ref/claude-connector.md` — field thật của dialog claude.ai
- `docs/ref/oauth-research-2026-08-07.md` — research dẫn tới quyết định đổi sang OAuth, ngày giờ + link nguồn
- `docs/ref/security-model.md` — mô hình bảo mật OAuth hiện tại

## Decision
**Action** → `README.md` (setup steps đã phản ánh quyết định này).
