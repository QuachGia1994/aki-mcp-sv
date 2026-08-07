# Research — claude.ai OAuth custom connector (2026-08-07)

Research thật, ngày giờ + link nguồn ghi đầy đủ, không suy đoán.

## Sự kiện khởi phát

Chạy thật `npm start` với kiến trúc token-in-URL, dán URL vào claude.ai → lỗi: "Couldn't register with sign-in service... If this persists, share this reference with support: ofid_60b6ac390c8c766a"

## Nguyên nhân — DCR luôn bị claude.ai thử trước

claude.ai luôn tự động thử Dynamic Client Registration (DCR) khi thêm custom connector, kể cả khi để trống OAuth Client ID/Secret — không có cách khai báo "server này không dùng OAuth" qua UI thường. Xác nhận qua [anthropics/claude-ai-mcp#457](https://github.com/anthropics/claude-ai-mcp/issues/457), đúng y hệt tình huống repo này.

## 3 lựa chọn tìm được — chọn OAuth tối giản, bỏ qua DCR

Nguồn: [claude.com/docs/connectors/building/authentication](https://claude.com/docs/connectors/building/authentication) (đọc 2026-08-07).

1. `static_headers` (Request headers, beta) — đúng nhu cầu nhất nhưng "being slowly rolled out to customers; contact Anthropic for early access", không chắc có ngay.
2. OAuth với client ID/Secret tự cấp, bỏ qua DCR — trích nguyên văn: "Supplying your own pre-registered client ID (and secret...) as static client credentials... avoids dynamic client registration entirely." Field đã có sẵn, không cần beta — **chọn phương án này**.
3. Báo bug, chờ Anthropic fix — loại vì cần go-live ngay.

## Điều kiện kỹ thuật bắt buộc

Nguồn cùng trang + [troubleshooting](https://claude.com/docs/connectors/building/troubleshooting) (đọc 2026-08-07):

- AS metadata không có `registration_endpoint`, không đặt `client_id_metadata_document_supported: true` → báo hiệu không DCR/CIMD, buộc claude.ai dùng client ID/Secret dán tay.
- `code_challenge_methods_supported: ["S256"]` bắt buộc quảng cáo, verify đúng `sha256(code_verifier)` base64url so với `code_challenge`.
- `401` (không phải `200`) kèm `WWW-Authenticate: Bearer resource_metadata="..."` khi `/mcp` thiếu/sai bearer.
- `redirect_uri` khớp chính xác `https://claude.ai/api/mcp/auth_callback`.
- `/token` nhận `Content-Type: application/x-www-form-urlencoded`, không phải JSON.

## Quyết định kiến trúc

Bỏ token-in-URL, tự dựng authorization server tối giản trong `scripts/oauth.js`: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/authorize` (trang xác nhận bằng passphrase, dùng lại `data/.token`), `/token` (PKCE S256, cấp access + refresh token, không rotate refresh vì đây là confidential client). Không có `/register` — dùng client ID/Secret sinh 1 lần (`data/.oauth-client.json`), dán tay vào Advanced settings.

## Vòng debug 1 — thiếu `iss` (RFC 9207)

Test thật: `/authorize` GET → 200, POST → 302 kèm `code` redirect đúng — nhưng log không có `POST /token`, claude.ai báo "Authorization with the MCP server failed".

Nguồn: [modelcontextprotocol.io/specification/draft/basic/authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization) (đọc 2026-08-07), mục "Authorization Response Validation": AS phát `iss` trong authorization response phải advertise `authorization_response_iss_parameter_supported: true` trong metadata (RFC9207 §2.3).

Fix áp dụng: `handleAuthorize` thêm `iss=<origin>` vào redirect; metadata AS thêm `authorization_response_iss_parameter_supported: true`.

**Retest — vẫn fail y hệt** (`ofid_752081d484c32ef1`, sau đó các `ofid_` khác), log vẫn không có `POST /token`. Giả thuyết thiếu `iss` không phải nguyên nhân duy nhất — cần điều tra thêm, không dừng ở đây.

## Vòng debug 2 — thiếu route `/.well-known/oauth-protected-resource/mcp` (RFC 9728 path-insertion)

Đối chiếu checklist chính thức trong [troubleshooting](https://claude.com/docs/connectors/building/troubleshooting): "If your MCP endpoint includes a path component (such as `https://your-server.example.com/mcp`), append it to the well-known path: `/.well-known/oauth-protected-resource/mcp`." Server này (`/mcp` có path) trước đó chỉ phục vụ metadata ở root `/.well-known/oauth-protected-resource`, không phục vụ ở bản gắn path — sai với RFC 9728 khi resource có path component. Ví dụ connector đang hoạt động (Sentry) trong [issue #215](https://github.com/anthropics/claude-ai-mcp/issues/215) cũng advertise cả 2 dạng trong `WWW-Authenticate`.

Fix áp dụng trong `scripts/gatekeeper.js`: phục vụ `protectedResource`/`authorizationServer` ở cả route gốc và route gắn `/mcp`; `WWW-Authenticate` trên `/mcp` trỏ về `resource_metadata` dạng gắn path.

## Vòng debug 3 — thiếu CORS trên `/authorize` và `/token`

Đọc trực tiếp source code reference implementation chính thức của MCP TypeScript SDK — `packages/server-legacy/src/auth/handlers/authorize.ts` và `handlers/token.ts` tại [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) (đọc 2026-08-07, qua `gh api`) — đây là code mà các MCP connector claude.ai đang hỗ trợ dùng làm nền. Cả 2 handler đều mount `router.use(cors())` (`Access-Control-Allow-Origin: *`) và `res.setHeader('Cache-Control', 'no-store')` trước khi xử lý request; router `/authorize` khai `allowedMethods(['GET', 'POST'])`, router `/token` khai `allowedMethods(['POST'])` — cả 2 đều đi qua middleware CORS nên đồng thời phục vụ `OPTIONS` preflight. Server này (`scripts/gatekeeper.js`) trước đó không set header CORS nào trên `/authorize`/`/token`/well-known, và không xử lý `OPTIONS` (rơi vào nhánh 404 chung).

Đây khớp chính xác cơ chế gây triệu chứng đã quan sát: nếu client-side JS của claude.ai gọi `/token` bằng `fetch()` từ trình duyệt, trình duyệt tự chặn request ở tầng CORS trước khi ra mạng nếu thiếu `Access-Control-Allow-Origin` — request thật không bao giờ tới được `/token`, khớp với log gatekeeper không bao giờ ghi nhận `POST /token` dù `/authorize` chạy đúng.

Fix áp dụng: `scripts/gatekeeper.js` set `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers` và trả `204` cho `OPTIONS` trên `/token`, `/authorize`, cả 4 route well-known; `scripts/oauth.js` thêm `Cache-Control: no-store` trên response của `handleAuthorize` và `handleToken`.

Chưa retest thật trên claude.ai sau fix này.

## Vòng debug 4 — CORS chỉ áp cho `/token`/`/authorize`, thiếu `/mcp` + `Access-Control-Expose-Headers`

Bằng chứng mới từ chính user: bấm "Add custom connector" xong, claude.ai báo ngay "Connection issue — Couldn't connect to the server" ở bước "checking connection..." — **trước cả khi vào `/authorize`**. Đối chiếu tiếp `examples/oauth/server.ts` trong [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) (đọc 2026-08-07, qua `gh api`) — app mẫu áp `cors({ origin: '*', exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate', 'Last-Event-Id', 'Mcp-Protocol-Version'] })` ở **tầng toàn app**, phủ cả `/mcp`, không chỉ `/token`/`/authorize`. `exposedHeaders` bắt buộc vì trình duyệt mặc định chặn JS đọc response header trừ khi server khai `Access-Control-Expose-Headers` — thiếu nó, JS phía claude.ai gọi thẳng `/mcp` để đọc `WWW-Authenticate` (tìm `resource_metadata`) trong bước "checking connection" sẽ không đọc được gì, sinh đúng lỗi chung chung "couldn't connect" quan sát được.

Fix áp dụng: `scripts/gatekeeper.js` chuyển CORS từ danh sách path cụ thể sang áp cho **mọi** response (kể cả `/mcp`), thêm `Access-Control-Expose-Headers: WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version`.

Ngoài ra, referrer URL user cung cấp (`claude.ai/new?error_code=mcp_token_exchange_failed`) xác nhận claude.ai **có** gọi `/token` phía server-to-server ở một lần thử trước — nhưng log gatekeeper mọi lần đều dừng ở `POST /authorize -> 302`, không có dòng `POST /token`. Test thủ công từ internet thật (`curl`) xác nhận `/token`/`/.well-known/*` reachable, TLS hợp lệ, response đúng format — network path và code `/token` tự nó không sai. Nghĩa là request `/token` bị chặn trước khi tới được gatekeeper — khớp với giả thuyết CORS/pre-check phía trên hơn là lỗi logic trong `handleToken`.

Chưa retest thật trên claude.ai sau fix này (cần Ctrl+C + `npm start` lại để nạp code mới).

## Vòng debug 5 — root cause thật: Tailscale Funnel desync với control plane, không phải bug code

Bằng chứng quyết định: mọi lần test trước đều chạy `curl` **từ chính máy Mac đang chạy `npm start`**. Máy này nằm trong cùng tailnet nên hệ điều hành tự dùng resolver nội bộ của Tailscale (`100.100.100.100`, xác nhận qua `scutil --dns`) — DNS trả về IP nội bộ dải CGNAT (`100.72.70.62`), và toàn bộ traffic đi thẳng qua mesh WireGuard, không hề chạm tới hạ tầng Funnel công khai thật sự. Mọi test full round-trip (`/authorize` → `/token`) "thành công" trước đó đều đi đường tắt này — không phản ánh đường đi thật của claude.ai (client hoàn toàn ngoài tailnet).

Resolve domain bằng DNS công khai (`dig @8.8.8.8`) cho kết quả khác hẳn: IP thật `103.84.155.217` / `103.84.155.153` — đây là edge routing công khai của Tailscale Funnel. `curl --resolve` thẳng vào các IP này (ép bỏ qua resolver nội bộ, mô phỏng đúng đường claude.ai đi) cho kết quả `SSL_ERROR_SYSCALL` — TLS handshake chết giữa chừng, request chưa từng chạm tới code. Khớp chính xác với "checking connection... Connection issue" — bước đầu tiên claude.ai làm, trước cả OAuth.

Đối chiếu [tailscale/tailscale#19508](https://github.com/tailscale/tailscale/issues/19508) (đọc 2026-08-07): serve/funnel config có thể lưu đúng cục bộ (`tailscale funnel status` báo "on") nhưng **không được đồng bộ lên control plane** — hạ tầng anycast công khai của Tailscale không nhận được state, nên client thật ngoài internet bị drop ở tầng TLS dù mọi thứ nhìn "on" từ máy chủ. Đây đúng là lớp lỗi quan sát được — không phải bug trong `scripts/oauth.js`/`gatekeeper.js`.

Fix áp dụng: chạy lại `tailscale funnel --bg 9999` (ép đẩy lại serve-config lên control plane) — không phải sửa code. Retest full round-trip `/authorize` → `/token` bằng `curl --resolve` thẳng vào IP công khai `103.84.155.217`: **200 OK trọn vẹn**, `access_token` cấp thành công qua đúng đường đi thật.

**Bài học để không tái diễn**: khi debug 1 kiến trúc dùng Tailscale Funnel, luôn test bằng `curl --resolve <host>:443:<public-IP-từ-dig-@8.8.8.8>` thay vì `curl https://<host>` trần — nếu máy test nằm trong cùng tailnet với server, DNS/route nội bộ sẽ che giấu hoàn toàn lỗi desync control-plane này. Dấu hiệu nhận biết: `tailscale funnel status` báo "on" nhưng client thật ngoài internet vẫn không kết nối được — luôn nghi ngờ desync trước, không suy đoán sang lỗi OAuth/code.

## Vòng debug 6 — sau khi OAuth chạy đúng: thiếu proxy route `/messages` (transport SSE cũ của mcp-hub)

Sau fix Funnel, log thật lần đầu cho `POST /token -> 200` — OAuth hoàn tất đúng chuẩn. Lỗi tiếp theo: `POST /mcp -> 404` rồi client tự fallback `POST /messages?sessionId=... -> 404`.

Kiểm tra trực tiếp `mcp-hub` (upstream thật, `npm ls mcp-hub` → bản `4.2.1`) bằng `curl` bỏ qua gatekeeper: `GET http://127.0.0.1:19999/mcp` trả về SSE stream với `event: endpoint, data: /messages?sessionId=...` — xác nhận `mcp-hub` bản này cài transport **HTTP+SSE cũ** (pre-2025-03-26 MCP spec), không phải Streamable HTTP hiện đại. Theo transport này, `POST /mcp` không bao giờ là route hợp lệ — client bắt buộc phải POST JSON-RPC tới `/messages?sessionId=...` lấy từ event `endpoint` trên SSE stream.

`scripts/gatekeeper.js` trước đó chỉ proxy đúng path `/mcp` (chủ đích ban đầu: chặn `/api/*` không auth của `mcp-hub` khỏi internet — xem `docs/plan/init.md`), vô tình chặn luôn `/messages` — collateral damage ngoài chủ đích gốc.

Fix áp dụng: route filter trong `scripts/gatekeeper.js` mở thêm `path === '/messages'` (cùng bearer-gate, cùng `forwardToHub`), giữ nguyên chặn mọi path khác kể cả `/api/*`. Verify local qua gatekeeper thật (không qua mock): lấy access token thật qua full OAuth flow → mở SSE `/mcp` lấy `sessionId` → POST `/messages?sessionId=...` qua gatekeeper → **202 Accepted**, đúng hành vi transport SSE (kết quả JSON-RPC trả về qua stream, không qua response của POST).

## Vòng debug 7 — sau khi `/messages` mở: claude.ai vẫn "no tools available" vì không dùng đúng dance SSE cũ

Sau fix vòng 6, connector chuyển từ "Connection issue" sang connect được nhưng "This connector has no tools available." Log gatekeeper đầy đủ từ lúc `npm start` tới lúc UI báo trống tools cho thấy: **không có dòng `GET /mcp` nào cả** — claude.ai không mở kết nối SSE để lấy `endpoint` event. Thay vào đó nó POST thẳng `/mcp` (404, vì `mcp-hub` không có route này), thi thoảng mở được `/messages?sessionId=...` (202, chỉ đủ gửi `initialize`), rồi lại quay về POST `/mcp` liên tục — không bao giờ tới được bước `tools/list`.

Đối chiếu với reference implementation chính thức của MCP TypeScript SDK (`examples/client/streamableHttpWithSseFallbackClient.ts`, gói `@modelcontextprotocol/sdk@1.30.0` trên npm, đọc 2026-08-07): pattern chuẩn là "học `endpoint` URL đúng 1 lần từ SSE, rồi dùng lại `_endpoint` đó cho **mọi** message sau" (`packages/client/src/client/sse.ts`, hàm `_send`). Hành vi log thật của claude.ai không khớp pattern này — nó thử lại `POST /mcp` (Streamable HTTP) cho từng bước thay vì giữ nguyên kênh `/messages` đã học được. Đây không phải bug của claude.ai để mặc kệ (cấm suy đoán theo hướng đó) — đây là bằng chứng cho thấy `mcp-hub` (chỉ nói được transport HTTP+SSE cũ, pre-2025-03-26) không đủ tương thích với cách một client hiện đại thực tế vận hành, và phần thiếu là ở phía server của ta.

**Root cause thật + fix:** thay vì tiếp tục phụ thuộc vào việc client tự fallback đúng cách, tự viết **shim Streamable HTTP** ngay trong gatekeeper (`scripts/streamable-bridge.js`) — nhận `POST /mcp` (JSON-RPC, đúng chuẩn hiện đại, 1 endpoint duy nhất), bắc cầu nội bộ sang transport cũ của `mcp-hub` (mở `GET /mcp` lấy `sessionId` nội bộ, POST `/messages?sessionId=...`, khớp response theo `id` JSON-RPC qua SSE), trả JSON trực tiếp lại cho client kèm header `Mcp-Session-Id` riêng của gatekeeper. Từ góc nhìn claude.ai, `/mcp` giờ là Streamable HTTP thật — không còn phụ thuộc vào việc client có tự fallback đúng theo cách `mcp-hub` yêu cầu hay không.

Verify local: dựng gatekeeper test riêng ở cổng khác (`19998`, trỏ vào đúng `mcp-hub` thật đang chạy ở `19999`, không đụng tiến trình `npm start` thật của user), lấy access token thật qua full OAuth flow, rồi mô phỏng **đúng y hệt** pattern request thật của claude.ai (`POST /mcp` initialize → dùng `Mcp-Session-Id` trả về cho `notifications/initialized` và `tools/list`, không mở `GET /mcp`) → `tools/list` trả đủ **15 tools** đúng tên. `scripts/gatekeeper.js` route `/mcp`: `POST` → shim, `DELETE` → đóng session, `GET` → `405` (không hỗ trợ server-push, chấp nhận được theo spec — `tools/list` không cần kênh này).

## Xác nhận thành công — MVP hoàn thành end-to-end

Retest thật trên claude.ai sau fix vòng 7 (restart `npm start`, connector kết nối lại): tools list hiện đủ 15 tools (14 `filesystem__*` + `shell__execute`), gọi tool được bình thường. Toàn bộ chuỗi OAuth → Streamable HTTP shim → mcp-hub → filesystem/shell MCP server hoạt động đúng thiết kế. Checklist đầy đủ: `docs/plan/init.md`.

## Đánh đổi đã biết, chấp nhận cho MVP 1 người dùng

- Access/refresh token chỉ lưu in-memory trong process gatekeeper — restart `npm start` làm mất hết phiên đã cấp, claude.ai cần "Connect" lại. Chấp nhận được vì chạy foreground, chủ động bật/tắt theo quyết định gốc.
- Không rate-limit `/authorize` — chấp nhận vì passphrase 256-bit, brute-force bất khả thi.

## Cross-references
- `docs/ref/security-model.md` — mô hình bảo mật cập nhật theo kiến trúc OAuth này
- `docs/plan/init.md` — bảng quyết định kiến trúc
- `scripts/oauth.js`, `scripts/gatekeeper.js` — implementation thật
