# mcp-local

> **Vị trí repo (tuyệt đối):** `/Volumes/DEV/Nodejs/aki-mcp-sv`. Filesystem MCP scope là cả `/Volumes/DEV` nên cần biết repo nằm đâu để 1 phiên claude.ai khác tự tìm lại mà sửa chính MCP này.

Chạy MCP server (filesystem + shell read-only) trên máy local, expose qua Tailscale Funnel để claude.ai (hoặc AI khác ngoài internet) kết nối được bằng custom connector.

Quyết định kiến trúc và lý do: xem `docs/plan/init.md`.

## Kiến trúc

```
Claude web (claude.ai)
      │  HTTPS + OAuth 2.1 (DCR bị bỏ qua, dùng client ID/secret tự cấp)
      ▼
Tailscale Funnel        (https://may-ban.ten-tailnet.ts.net)
      │
      ▼
gatekeeper.js  — cổng public 9999
      │           /.well-known/oauth-*  metadata
      │           /authorize, /token    authorization server tối giản (scripts/oauth.js)
      │           /mcp                  bắt buộc Bearer access token hợp lệ, sai → 401
      │                                 POST → Streamable HTTP thật (scripts/streamable-bridge.js)
      ▼
mcp-hub        — nội bộ (loopback), cổng 19999, transport HTTP+SSE cũ (GET /mcp + POST /messages)
      │
      ├─► MCP filesystem server   (đọc/ghi trong $MCP_DATA_DIR)
      └─► MCP shell server        (shell-mcp.js — whitelist lệnh xem-thôi)
```

`mcp-hub` có sẵn 1 REST API quản trị không auth (`/api/*`) trên cùng port — `gatekeeper.js` là lớp chặn để port đó không bao giờ lộ ra internet. Chi tiết: `docs/plan/init.md`.

Dùng OAuth (không token-in-URL) vì claude.ai luôn tự thử Dynamic Client Registration bất kể cấu hình — chi tiết: `docs/ref/oauth-research-2026-08-07.md`.

## Yêu cầu

- macOS, Node.js đã cài sẵn
- [Tailscale](https://tailscale.com) đã setup (app hoặc CLI đều được — `tailscale` cần có trên PATH), Funnel đã bật cho tailnet (1 lần qua link `login.tailscale.com/f/funnel` nếu chưa)

## Cấu trúc thư mục

```
mcp-local/
├── package.json
├── mcp-hub.config.json
├── scripts/
│   ├── start.js               # orchestrate mcp-hub + gatekeeper
│   ├── gatekeeper.js           # OAuth-protected reverse proxy, cổng public
│   ├── oauth.js                 # authorization server tối giản (DCR bị bỏ qua)
│   ├── streamable-bridge.js    # shim Streamable HTTP <-> transport SSE cũ của mcp-hub
│   └── shell-mcp.js            # shell tool tự viết, allowlist-gated (read-only mặc định)
└── data/                       # thư mục mặc định MCP filesystem được phép truy cập + secrets
```

## Cài đặt

```bash
git clone <repo-url> mcp-local
cd mcp-local
npm install
mkdir -p data
```

## Chạy

```bash
npm start
```

Không cần chuẩn bị gì trước — `npm start` tự lo:
- **Passphrase** (`data/.token`) + **OAuth client ID/secret** (`data/.oauth-client.json`): lần đầu tự sinh, các lần sau đọc lại y nguyên.
- **Funnel**: tự kiểm tra `tailscale funnel status`, nếu cổng `9999` chưa được bật thì tự `tailscale funnel --bg 9999` (idempotent — không toggle nếu đã bật sẵn).
- In ra đúng 4 giá trị cần dùng: **Remote MCP server URL**, **OAuth Client ID**, **OAuth Client Secret** (dán vào claude.ai), và **Passphrase** (nhập ở trang xác nhận khi bấm Connect).
- Ghi thêm `data/config.html`: GUI để copy URL/secret/passphrase, prompt instruction và link extension. File cục bộ, không phục vụ qua Funnel; mở bằng `open data/config.html`.

Mặc định filesystem MCP đọc/ghi trong **`/Volumes/DEV`** (toàn bộ volume code). Đổi phạm vi cho 1 phiên:
```bash
MCP_DATA_DIR=/path/khac npm start
```
Ngoài `$MCP_DATA_DIR`, filesystem MCP được cấp thêm `~/.aki` (rule corpus deploy) và `~/.claude` để claude.ai đọc **native** `CLAUDE.md` + `CLAUDE.local.md` (và `skills/akirule/SKILL.md` router) như Claude Code — không copy, không staging, không bản sao. Prompt trong `data/config.html` bảo claude web đọc `~/.claude/CLAUDE.md` + `CLAUDE.local.md` + 4 file rule dưới `~/.aki` đầu mỗi phiên.

`~/.claude` mở cả gốc (để đọc native `CLAUDE.md` + `CLAUDE.local.md` — server-filesystem cấp theo thư mục, không per-file). **Hệ quả:** `.claude.json`/`auth-cache.json` (session token) và `history.jsonl` (lịch sử chat) trong đó cũng đọc/ghi được qua connector. Chấp nhận vì single-user + OAuth+passphrase gated.

`npm start` chạy foreground như trước — Ctrl+C để dừng, tự tay bật lại khi cần dùng. **Sửa code rồi phải Ctrl+C + `npm start` lại** — Node không tự nạp lại file đang chạy.

## Public hóa qua Tailscale

`npm start` tự bật funnel khi cần (xem trên) — không phải chạy tay nữa. Funnel là cấu hình lưu trong `tailscaled` (sống qua reboot), độc lập với vòng đời `npm start`; tắt hẳn bằng `tailscale funnel 9999 off`.

**Funnel — cần biết trước khi bật:**
- Miễn phí trên mọi gói Tailscale, nhưng phải bật 1 lần cấp tailnet trước (link `login.tailscale.com/f/funnel?node=...` nếu chưa bật, `tailscale funnel --bg` sẽ tự in ra).
- Chỉ chạy được trên 1 trong 3 cổng: `443`, `8443`, `10000` — không public được cổng tùy ý.
- Băng thông có giới hạn nhưng Tailscale không công bố số cụ thể.
- Đừng bật/tắt funnel liên tục — cấp lại chứng chỉ nhiều lần có thể dính rate limit của Let's Encrypt (khóa ~34 giờ).

**Chẩn đoán "claude.ai không kết nối được" dù `tailscale funnel status` báo "on":** đây là lớp lỗi thật đã gặp — serve-config lưu đúng cục bộ nhưng không đồng bộ lên control plane của Tailscale, khiến client thật ngoài internet bị chặn ở tầng TLS trong khi máy chủ (đi qua mesh nội bộ) thấy mọi thứ bình thường. **Không test bằng `curl https://<host>` trần trên chính máy chạy `npm start`** — máy đó nằm trong tailnet nên tự đi tắt qua mesh, không phản ánh đường đi thật. Test đúng bằng:
```bash
dig @8.8.8.8 <host> A +short   # lấy IP công khai thật
curl --resolve <host>:443:<IP-vừa-lấy> https://<host>/.well-known/oauth-authorization-server
```
Nếu lệnh trên trả `SSL_ERROR_SYSCALL`/timeout dù `tailscale funnel status` báo "on" → chạy lại `tailscale funnel --bg 9999` để ép đẩy lại config lên control plane (không phải lỗi code). Chi tiết + bằng chứng đầy đủ: `docs/ref/oauth-research-2026-08-07.md` mục "Vòng debug 5".

## Kết nối với Claude web

1. Vào **claude.ai → Settings → Connectors → Add custom connector**
2. **Remote MCP server URL**: dán `https://may-ban.ten-tailnet.ts.net/mcp` (`npm start` in ra)
3. **Advanced settings → OAuth Client ID / OAuth Client Secret**: dán 2 giá trị `npm start` in ra
4. Nhấn **Connect** — trình duyệt sẽ mở trang xác nhận nội bộ, nhập đúng **passphrase** (nội dung file `data/.token`) để duyệt

Vì sao không dùng token-in-URL nữa: `docs/ref/claude-connector.md`, `docs/ref/oauth-research-2026-08-07.md`.

claude.ai kết nối được và gọi 14 tool `filesystem__*` + `shell__run_cmd`.

## Bảo mật

OAuth 2.1 tối giản, Dynamic Client Registration bị bỏ qua có chủ đích (dùng client ID/secret tự cấp thay vì để claude.ai tự đăng ký). Giải thích đầy đủ (luồng request thật, 2 lớp chặn thật sự, giới hạn đã biết): `docs/ref/security-model.md`.

- `$MCP_DATA_DIR` (mặc định `/Volumes/DEV`) là root chính filesystem MCP đọc/ghi, cộng thêm `~/.aki` + `~/.claude` (đọc native rule file) — chốt lúc khởi chạy, không đổi được giữa phiên. `~/.claude` mở cả gốc nên token/lịch sử chat trong đó nằm trong tầm connector; chấp nhận vì single-user + OAuth+passphrase.
- Shell MCP tự viết (`shell-mcp.js`), enforce whitelist bằng code (`execFile`, không qua shell, chặn `; & | ` \` `), không dùng package `shell-mcp` trên npm vì nó không có whitelist thật. Allowlist gồm bộ lệnh read-only cứng trong code, mở rộng được qua `~/.aki/mcpsv/setting.json` → `shell.allowlist` (thiếu file = chỉ dùng defaults). **Lệnh do bạn tự thêm ở settings là trách nhiệm của bạn**: thêm lệnh ghi (vd `git commit`) là vượt ranh giới "chỉ đọc" mà `docs/plan/repl-config-tools.md` đánh dấu cần plan bảo mật riêng. Lệnh chạy được trong bất kỳ thư mục nào dưới `$MCP_DATA_DIR` qua tham số `cwd` (cùng ranh giới với filesystem MCP): đó là cách trỏ đúng repo thay cho `cd`/`-C`.
- `gatekeeper.js` là điểm chốt duy nhất công khai — `mcp-hub` thật không bao giờ nghe ngoài loopback.
- `data/.token` (passphrase duyệt `/authorize`) và `data/.oauth-client.json` (client ID/secret) — không commit, không chia sẻ ngoài việc dán vào connector 1 lần.
- Access/refresh token lưu ở `data/.tokens.json` (mode 0600, không commit) nên sống qua restart — connector là quyền truy cập file dài hạn, không phải phiên đăng nhập, mất token mỗi lần `npm start` chỉ tạo ra việc nhập passphrase vô ích. Access token TTL 1 năm, refresh token không hết hạn. Thu hồi = xoá `data/.tokens.json` rồi restart.
- Funnel bật nền tự động khi cần cho cả project — routing luôn sẵn, chỉ tiến trình `npm start` là thứ bạn chủ động bật/tắt.

### Vì sao whitelist, không phải blocklist (khác Desktop Commander)

Desktop Commander — MCP terminal phổ biến nhất — bảo vệ bằng **blocklist** (`blockedCommands`: liệt kê các lệnh bị cấm). Cách đó về bản chất không kín: không thể liệt kê hết mọi lệnh và mọi biến thể nguy hiểm, và vì mặc định là *cho phép chạy*, mọi lệnh mới hay cách gọi lạ đều lọt qua cho tới khi có người nghĩ ra mà thêm vào danh sách cấm.

Server này làm ngược lại — **whitelist**: mặc định *từ chối*, chỉ chạy đúng thứ có trong allowlist. Với một server tự expose ra internet qua Funnel, khác biệt này là an toàn thật chứ không phải khẩu hiệu:
- **Fail-safe** — lệnh lạ hoặc mới bị chặn tự động, không cần đoán trước nó có nguy hiểm hay không.
- **Bề mặt tấn công tối thiểu** — chỉ đúng số lệnh bạn đã duyệt mới chạy được, không hơn.
- **Granular tới cấp subcommand** — `git` chỉ cho `status/log/diff/show`; blocklist rất khó biểu đạt kiểu chặn này cho gọn.
- **Read-only theo mặc định** — bộ lệnh cứng chỉ gồm lệnh đọc; muốn thêm thì tự thêm ở `~/.aki/mcpsv/setting.json` một cách có ý thức, chứ không phải đi gỡ một lệnh cấm.
