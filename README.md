# mcp-local

Chạy MCP server (filesystem + shell read-only) trên máy local, expose qua Tailscale Funnel để claude.ai (hoặc AI khác ngoài internet) kết nối được bằng custom connector.

Control panel `npm start` mở ra tự in đường dẫn repo hiện tại vào prompt instruction, nên một phiên claude.ai khác biết ngay chỗ sửa chính MCP này — repo đặt ở đâu cũng được.

Phiên bản: **1.0.0** ([CHANGELOG.md](CHANGELOG.md)) · Giấy phép MIT · macOS.

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
      ├─► MCP search server       (search-mcp.js — find_path/search_content, quét cả cây 1 lần)
      └─► MCP shell server        (shell-mcp.js — whitelist lệnh xem-thôi)

panel.js       — 127.0.0.1:9998, KHÔNG bao giờ ra Funnel
                 UI điều khiển: thư mục cấp quyền, allowlist shell, restart hub,
                 cài akidevrule, sinh prompt instruction, Chrome CDP
```

`mcp-hub` có sẵn 1 REST API quản trị không auth (`/api/*`) trên cùng port — `gatekeeper.js` là lớp chặn để port đó không bao giờ lộ ra internet. Chi tiết: `docs/plan/init.md`.

Dùng OAuth (không token-in-URL) vì claude.ai luôn tự thử Dynamic Client Registration bất kể cấu hình — chi tiết: `docs/ref/oauth-research-2026-08-07.md`.

## Yêu cầu

- macOS, Node.js đã cài sẵn
- Tailscale — làm 2 việc một lần duy nhất:
  1. [Tải & cài Tailscale](https://tailscale.com/download) rồi đăng nhập (app hoặc `brew install tailscale` đều được, miễn lệnh `tailscale` có trên PATH)
  2. Bật [Funnel](https://tailscale.com/docs/features/tailscale-funnel) cho tailnet — miễn phí ở mọi gói, bật 1 lần qua link `login.tailscale.com/f/funnel` mà `npm start` in ra nếu chưa bật

Từ đó trở đi `npm start` tự bật Funnel cho cổng 9999 mỗi lần chạy. Panel cũng có mục 1 nhắc lại 2 bước này kèm link.

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
│   ├── shell-mcp.js            # shell tool tự viết, allowlist-gated (read-only mặc định)
│   ├── allowlist.js            # bộ lệnh mặc định + đọc settings — dùng chung server và panel
│   ├── search-mcp.js           # find_path / search_content — quét cả cây trong 1 lần gọi
│   ├── roots.js                # path containment dùng chung cho mọi tool chạm filesystem
│   ├── tailscale.js            # đọc trạng thái Funnel — dùng chung start.js và panel
│   ├── panel.js                # control panel loopback-only (:9998), token-gated
│   ├── config-page.js          # render trang panel
│   ├── userdata.js             # đường dẫn dữ liệu người dùng (~/.aki/mcpsv) — SSoT, tự chuyển từ data/ cũ
│   └── chrome.js               # CDP client tối giản; mở Chrome khi chưa chạy, việc thoát Chrome nằm sau nút riêng
├── mcp-hub.config.json         # bản mặc định được ship, dùng placeholder ${MCP_DATA_DIR}/${HOME}
└── public/                     # favicon + ảnh, gatekeeper phục vụ công khai
```

Dữ liệu của bạn nằm ngoài repo, ở `~/.aki/mcpsv/` — giống chỗ mọi CLI để setting:

```
~/.aki/mcpsv/
├── mcp-hub.config.json   # cấu hình đang chạy thật (thư mục bạn cấp quyền)
├── setting.json          # allowlist shell bạn sửa ở panel
├── oauth-client.json     # client ID + secret (0600)
├── passphrase.txt        # passphrase duyệt /authorize (0600)
└── tokens.json           # access/refresh token (0600)
```

Clone giữ nguyên như lúc checkout: sửa gì trong panel cũng không đẻ ra diff. Bản cài cũ ghi vào `<repo>/data/` được tự copy sang lần chạy đầu — không mất client ID/passphrase, và thư mục cũ vẫn còn nguyên để xoá tay khi yên tâm.

## Cài đặt

```bash
git clone <repo-url> mcp-local
cd mcp-local
npm install
```

## Chạy

```bash
npm start
```

Không cần chuẩn bị gì trước — `npm start` tự lo:
- **Passphrase** + **OAuth client ID/secret** trong `~/.aki/mcpsv/`: lần đầu tự sinh, các lần sau đọc lại y nguyên.
- **Funnel**: tự kiểm tra `tailscale funnel status`, nếu cổng `9999` chưa được bật thì tự `tailscale funnel --bg 9999` (idempotent — không toggle nếu đã bật sẵn).
- In ra đúng 4 giá trị cần dùng: **Remote MCP server URL**, **OAuth Client ID**, **OAuth Client Secret** (dán vào claude.ai), và **Passphrase** (nhập ở trang xác nhận khi bấm Connect).
- Mở **control panel** `http://127.0.0.1:9998/?t=<token>` — 8 mục theo đúng thứ tự cần làm: Tailscale, connector, thư mục được cấp quyền, allowlist shell, akidevrule, prompt instruction, tiện ích, Chrome.

`mcp-hub.config.json` ở gốc repo là **bản mặc định được ship**, giữ nguyên placeholder. Lần chạy đầu nó được copy thành `~/.aki/mcpsv/mcp-hub.config.json` và từ đó chỉ đọc/ghi bản trong home — thư mục bạn cấp quyền là chuyện của máy bạn, không được biến thành diff trong clone của bạn.

Mặc định filesystem MCP đọc/ghi trong **home của bạn** (`$HOME`) — thư mục duy nhất chắc chắn tồn tại trên mọi máy và chứa code người dùng thật sự muốn Claude với tới. Thêm/bớt thư mục ở **mục 3 của panel**: nút "Chọn thư mục…" mở hộp thoại chọn thư mục của macOS (chọn nhiều cái một lần), lưu xong hub tự restart. Muốn đổi gốc ngay từ đầu thì `MCP_DATA_DIR=/path/khac npm start`.

Ngoài `$MCP_DATA_DIR`, filesystem MCP được cấp thêm `~/.aki` (nơi akidevrule deploy) và `~/.claude` để claude.ai đọc **native** `CLAUDE.md` (và `skills/akirule/SKILL.md` router) như Claude Code — không copy, không staging, không bản sao.

`~/.claude` mở cả gốc vì server-filesystem cấp quyền theo **thư mục**, không per-file. **Hệ quả:** `.claude.json`/`auth-cache.json` (session token) và `history.jsonl` (lịch sử chat) trong đó cũng đọc/ghi được qua connector. Không muốn thì xoá dòng `${HOME}/.claude` ở mục 3 của panel — đổi lại claude.ai sẽ không đọc được `CLAUDE.md` của bạn nữa.

`npm start` chạy foreground như trước — Ctrl+C để dừng, tự tay bật lại khi cần dùng. **Sửa code rồi phải Ctrl+C + `npm start` lại** — Node không tự nạp lại file đang chạy.

## Public hóa qua Tailscale

`npm start` tự bật funnel khi cần (xem trên) — không phải chạy tay nữa. Funnel là cấu hình lưu trong `tailscaled` (sống qua reboot), độc lập với vòng đời `npm start`; tắt hẳn bằng `tailscale funnel 9999 off`.

**Funnel — cần biết trước khi bật:**
- Miễn phí trên mọi gói Tailscale, nhưng phải bật 1 lần cấp tailnet trước (link `login.tailscale.com/f/funnel?node=...` nếu chưa bật, `tailscale funnel --bg` sẽ tự in ra).
- Chỉ chạy được trên 1 trong 3 cổng: `443`, `8443`, `10000` — không public được cổng tùy ý.
- Băng thông có giới hạn nhưng Tailscale không công bố số cụ thể.
- Đừng bật/tắt funnel liên tục — cấp lại chứng chỉ nhiều lần có thể dính rate limit của Let's Encrypt (khóa ~34 giờ). `start.js` chỉ bật khi thật sự chưa có: `tailscale funnel status --json` khoá `AllowFunnel` theo **cổng công khai (443)**, không theo cổng nội bộ, nên phải dò cổng 9999 trong `Web[].Handlers[].Proxy` — dò sai chỗ thì lần chạy nào cũng tưởng chưa bật và bật lại.

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
4. Nhấn **Connect** — trình duyệt sẽ mở trang xác nhận nội bộ, nhập đúng **passphrase** (nội dung file `~/.aki/mcpsv/passphrase.txt`) để duyệt

Vì sao không dùng token-in-URL nữa: `docs/ref/claude-connector.md`, `docs/ref/oauth-research-2026-08-07.md`.

### Điều khiển Chrome — vì sao có nút "Mở lại Chrome" riêng

Chrome chỉ mở cổng debug **lúc khởi động**: một Chrome đang chạy mà thiếu cờ thì không cách nào gắn vào được, phải thoát rồi mở lại. Nên panel tách đôi: "Kết nối Chrome" không bao giờ đóng gì (chưa chạy thì mở, đang chạy mà thiếu cờ thì báo và dừng lại), còn việc thoát Chrome nằm sau đúng một nút nói rõ nó sẽ làm gì. Trình duyệt của người dùng biến mất vì một cú bấm không hứa điều đó là lỗi UX, không phải tiện ích.

claude.ai kết nối được và gọi 14 tool `filesystem__*`, `search__find_path`, `search__search_content`, `shell__run_cmd`.

### Icon của connector: không sửa được từ phía server

claude.ai không lấy icon từ MCP server. Nó gọi dịch vụ favicon của Google với **apex domain của tailnet**, không phải host của bạn:

```
https://t2.gstatic.com/faviconV2?...&url=http://<tailnet>.ts.net&size=32
```

`<tailnet>.ts.net` không có bản ghi DNS công khai (`dig` không phân giải được) nên Google trả 404 và claude.ai vẽ icon chữ cái mặc định. Server này vẫn phục vụ `/favicon.ico` công khai, nhưng không có file nào ta đặt lên đổi được kết quả đó — subdomain của bạn không hề nằm trong câu hỏi Google nhận.

## Tìm file — dùng `find_path`, không duyệt từng cấp

`filesystem__search_files` không trả về thư mục và hay timeout trên cây lớn, nên một phiên từ xa có thể "không thấy" chính dự án nó đang được cấp quyền đọc. `search__find_path` quét cả cây trong một lần gọi (đo thật: ~0.2s để tìm 1 tên trong cây 164k file / 11.7k thư mục), trả về **cả file lẫn thư mục**, tự bỏ qua `node_modules`/`.git`/thư mục build. `query` là substring không phân biệt hoa thường, hoặc glob khi có `*`/`?`. Prompt sinh từ panel đã bắt ưu tiên tool này.

## Bảo mật

OAuth 2.1 tối giản, Dynamic Client Registration bị bỏ qua có chủ đích (dùng client ID/secret tự cấp thay vì để claude.ai tự đăng ký). Giải thích đầy đủ (luồng request thật, 2 lớp chặn thật sự, giới hạn đã biết): `docs/ref/security-model.md`.

- `$MCP_DATA_DIR` (mặc định `$HOME`) là root chính filesystem MCP đọc/ghi, cộng thêm `~/.aki` + `~/.claude` (đọc native rule file) — chốt lúc khởi chạy, đổi trong panel thì hub restart. `~/.claude` mở cả gốc nên token/lịch sử chat trong đó nằm trong tầm connector — biết mà quyết định, xoá được ở panel.
- Shell MCP tự viết (`shell-mcp.js`), enforce whitelist bằng code (`execFile`, không qua shell, chặn `; & | ` \` `), không dùng package `shell-mcp` trên npm vì nó không có whitelist thật. Bộ lệnh read-only mặc định ở `allowlist.js`; panel hiển thị sẵn đúng bộ đó để bạn sửa từ điểm xuất phát thật, lưu xuống `~/.aki/mcpsv/setting.json` → `shell.allowlist`. **Lệnh do bạn tự thêm là trách nhiệm của bạn**: thêm lệnh ghi (vd `git commit`) là vượt ranh giới "chỉ đọc" mà `docs/plan/repl-config-tools.md` đánh dấu cần plan bảo mật riêng. Lệnh chạy được trong bất kỳ thư mục nào dưới `$MCP_DATA_DIR` qua tham số `cwd` (cùng ranh giới với filesystem MCP): đó là cách trỏ đúng repo thay cho `cd`/`-C`.
- `gatekeeper.js` là điểm chốt duy nhất công khai — `mcp-hub` thật không bao giờ nghe ngoài loopback.
- `panel.js` ghi config và chạy lệnh trên máy nên **chỉ bind `127.0.0.1`**, không bao giờ đưa vào Funnel. Token sinh mới mỗi lần `npm start`, bắt buộc ở query khi mở trang và ở header `x-panel-token` cho mọi API — chặn trang web khác trong trình duyệt POST vào localhost.
- `~/.aki/mcpsv/passphrase.txt` (passphrase duyệt `/authorize`) và `~/.aki/mcpsv/oauth-client.json` (client ID/secret) — mode 0600, nằm ngoài repo nên không có đường vào git, không chia sẻ ngoài việc dán vào connector 1 lần.
- Access/refresh token lưu ở `~/.aki/mcpsv/tokens.json` (mode 0600) nên sống qua restart — connector là quyền truy cập file dài hạn, không phải phiên đăng nhập, mất token mỗi lần `npm start` chỉ tạo ra việc nhập passphrase vô ích. Access token TTL 1 năm, refresh token không hết hạn. Thu hồi = xoá `~/.aki/mcpsv/tokens.json` rồi restart.
- Funnel bật nền tự động khi cần cho cả project — routing luôn sẵn, chỉ tiến trình `npm start` là thứ bạn chủ động bật/tắt.

### Vì sao whitelist, không phải blocklist (khác Desktop Commander)

Desktop Commander — MCP terminal phổ biến nhất — bảo vệ bằng **blocklist** (`blockedCommands`: liệt kê các lệnh bị cấm). Cách đó về bản chất không kín: không thể liệt kê hết mọi lệnh và mọi biến thể nguy hiểm, và vì mặc định là *cho phép chạy*, mọi lệnh mới hay cách gọi lạ đều lọt qua cho tới khi có người nghĩ ra mà thêm vào danh sách cấm.

Server này làm ngược lại — **whitelist**: mặc định *từ chối*, chỉ chạy đúng thứ có trong allowlist. Với một server tự expose ra internet qua Funnel, khác biệt này là an toàn thật chứ không phải khẩu hiệu:
- **Fail-safe** — lệnh lạ hoặc mới bị chặn tự động, không cần đoán trước nó có nguy hiểm hay không.
- **Bề mặt tấn công tối thiểu** — chỉ đúng số lệnh bạn đã duyệt mới chạy được, không hơn.
- **Granular tới cấp subcommand** — `git` chỉ cho `status/log/diff/show`; blocklist rất khó biểu đạt kiểu chặn này cho gọn.
- **Read-only theo mặc định** — bộ lệnh cứng chỉ gồm lệnh đọc; muốn thêm thì tự thêm ở `~/.aki/mcpsv/setting.json` một cách có ý thức, chứ không phải đi gỡ một lệnh cấm.
