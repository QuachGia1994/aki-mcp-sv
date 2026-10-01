# Plan: AGY panel — 1-click apply + pre-allow (wildcard)

**Status:** DONE 2026-09-29 (v2) — cơ chế "Apply to AGY CLI" đổi từ `httpUrl → settings.json` sang `stdio → mcp_config.json` sau khi kiểm chứng trực tiếp trên máy (xem "Bằng chứng"). Transport `httpUrl`/`serverUrl` + Bearer KHÔNG dùng được cho agy CLI.
**Affects:** `scripts/panel.js` · `scripts/config-page.js` · `public/panel-client.js` · (prereq) `scripts/stdio.js`

---

## Context

Tab AGY trong Section 1 của panel hiện chỉ render hai khối JSON (AGY CLI + AGY IDE) để user tự copy rồi tự mở file merge thủ công. Trong khi đó mọi tab khác (Postman, Install Rules, Save allowlist…) đều hoạt động theo pattern 1-click → panel ghi file → hiện feedback. Tab AGY là ngoại lệ duy nhất vi phạm "don't make me think".

Vấn đề thứ hai: AGY CLI hỏi quyền từng `aki__*` tool mỗi lần gọi vì `permissions.allow` trong `settings.json` mới chỉ có vài tool được pre-allow thay vì cả server.

**Đính chính so với bản trước:** bản v1 cho rằng "Apply" nên ghi `mcpServers.akimcp = { httpUrl, headers: Bearer }` vào `~/.gemini/antigravity-cli/settings.json`. Điều này SAI ở hai tầng và đã được thay bằng cơ chế stdio → `mcp_config.json` (Problem 1 bên dưới).

---

## Bằng chứng đã kiểm chứng (đọc trước khi implement)

Những điều dưới đây đã xác minh trực tiếp trên máy — dùng làm nền cho mọi quyết định trong plan:

1. **agy CLI đọc MCP servers từ `~/.gemini/config/mcp_config.json`, KHÔNG phải `antigravity-cli/settings.json`.** Doc chính chủ (`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/mcp_servers.md`): file này là SSoT của MCP servers, chỉ hỗ trợ **hai** transport — stdio (`command` + `args` [+ `env`]) hoặc remote SSE (`serverUrl`). **Không có key `httpUrl`.** `settings.json` chỉ dùng cho model + `permissions` (không phải nơi khai báo MCP server).
2. **Endpoint `/mcp` luôn bắt buộc Bearer, không miễn trừ loopback** (`gatekeeper.js` gọi `verifyBearer` cho mọi request `/mcp`). Transport `serverUrl` (SSE) của agy không có trường `headers` → không có cách gắn token. ⇒ Cả `httpUrl` lẫn `serverUrl` đều bất khả thi cho agy CLI với server này.
3. **Token trong `instance.json` là *panel token* (`randomBytes(16)` tại `start.js`), KHÔNG phải OAuth access token của `/mcp`.** Test trực tiếp: `POST /mcp` với token này → **401 Unauthorized**. Token thật (verifyBearer chấp nhận) nằm trong `tokens.json` dạng nội bộ, và xoay khi roll/restart → không phải thứ đáng để một config tĩnh phụ thuộc.
4. **Kết luận transport:** transport local duy nhất chạy được là **stdio** — agy spawn `node scripts/stdio.js`, một MCP server in-process mount đúng `createToolsServer()` (cùng toolset với server HTTP), không cần token/port/không phụ thuộc tiến trình `:9999`. Đây là mô hình MCP-stdio chuẩn (như server-filesystem, Desktop Commander). Prereq: file `scripts/stdio.js` phải tồn tại (đã tạo lại — xem "Prereq").
5. **Danh tính server mà AGY dùng là `akimcp`** (AGY bỏ dấu gạch nối khi chuẩn hoá `aki-mcp`). ⇒ Đặt key config = `akimcp` (hằng `AGY_SERVER_KEY`) để không phụ thuộc chuẩn hoá ngầm, và chuỗi permission là `mcp(akimcp/*)`.
6. **Pre-allow `mcp(akimcp/*)` trong `antigravity-cli/settings.json` LÀ ĐÚNG và có tác dụng.** Xác minh end-to-end: sau khi có entry stdio trong `mcp_config.json` + `mcp(akimcp/*)` trong `settings.json`, chạy agy mới → `akimcp` **Connected (37 tools)**, gọi `aki__list_allowed_directories` chạy thật, **không popup hỏi quyền**. ⇒ `settings.json` vẫn là nơi ghi pre-allow, chỉ KHÔNG phải nơi khai báo server.
7. **Mọi tool đều được prefix `aki__`** qua `prefixedServer(server, 'aki__')` trong `tools-server.js`. Với wildcard `mcp(akimcp/*)` thì tên từng tool không còn quan trọng cho permission.
8. **Route handler chỉ nhận `(body, ctx)` với `ctx = { updateInfo }`** (`panel.js`). `accessToken`/`localUrl` không có trong ctx (và route mới không cần chúng nữa). `REPO_ROOT` là hằng module-level trong `panel.js` → dùng để build đường dẫn tuyệt đối tới `scripts/stdio.js`.
9. **`writeJsonAtomic` (panel.js) đã tự `mkdirSync(dirname, {recursive:true})`** trước khi ghi ⇒ fresh install (chưa có `~/.gemini/config/`) không crash. Dùng nó, đừng hand-roll `writeFileSync`.
10. **`panel-client.js` dùng object `ACTIONS`** + dispatch `data-act`. Key `agyApply` đã có, gọi `POST /api/agy-apply-mcp` và hiển thị `message` → **không cần đổi** khi ta chỉ đổi nội dung route.

---

## Prereq — `scripts/stdio.js` (đã tạo lại)

File từng bị xoá (chưa từng commit nên không recover từ git được), khiến `mcp_config.json` trỏ tới nó báo `MODULE_NOT_FOUND`. Đã tạo lại: một entry stdio in-process —

- Redirect `console.log/info/debug` → stderr **trước khi** load tool modules (dynamic import), vì `log.js` ghi `console.log` ra stdout mà stdout là kênh JSON-RPC của stdio MCP; frame protocol của transport đi thẳng `process.stdout.write` nên không bị ảnh hưởng.
- `createToolsServer()` từ `tools-server.js` + `StdioServerTransport`.
- Đã verify: `initialize` → server `aki-mcp`, `tools/list` = 39 tools, `tools/call aki__list_allowed_directories` trả roots, `isError=false`.

---

## Problem 1 — UX: tab AGY yêu cầu user tự merge file (và cơ chế cũ ghi sai file/transport)

### Hiện trạng (bản v1 đã implement, cần sửa)

Route `POST /api/agy-apply-mcp` ghi `mcpServers.akimcp = { httpUrl, headers: Bearer }` vào `~/.gemini/antigravity-cli/settings.json`. Sai file (agy không đọc MCP server ở đây) + sai transport (`httpUrl` không tồn tại; Bearer không gắn được). `config-page.js` render `agyJson` dạng `httpUrl` khớp với cơ chế sai đó.

### Fix — route ghi 2 file, mỗi file đúng vai trò

**Đổi route `POST /api/agy-apply-mcp` trong `panel.js`:**

```
A) MCP server → ~/.gemini/config/mcp_config.json (stdio):
   1. mcpConfigPath = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json')
   2. Đọc JSON hiện tại hoặc {} nếu chưa có (parse fail → throw thông báo rõ ràng).
   3. mcpConfig.mcpServers ||= {}
      mcpConfig.mcpServers[AGY_SERVER_KEY] = { command: 'node', args: [path.join(REPO_ROOT, 'scripts', 'stdio.js')] }
      (giữ nguyên playwright và mọi server khác)
   4. writeJsonAtomic(mcpConfigPath, mcpConfig)   // đã tự mkdir -p, atomic

B) Pre-allow → ~/.gemini/antigravity-cli/settings.json (chỉ permissions):
   5. settingsPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json')
   6. Đọc JSON hiện tại hoặc {}.
   7. DỌN entry sai cũ: nếu settings.mcpServers?.[AGY_SERVER_KEY] tồn tại → xoá (self-healing cho ai đã bấm bản v1).
   8. settings.permissions ||= { allow: [], deny: [] }; settings.permissions.allow ||= []
      settings.permissions.allow = [...new Set([...settings.permissions.allow, `mcp(${AGY_SERVER_KEY}/*)`])]
   9. writeJsonAtomic(settingsPath, settings)

Return { ok: true, message: 'Applied — akimcp (stdio) → mcp_config.json + pre-allow → settings.json. Restart agy.' }
```

- **Không còn dùng token/localUrl trong route này.** `getOrIssueAccessToken` vẫn được import vì `renderPanel` (GET /) và các consumer khác còn dùng.
- **Cross-platform:** `path.join(os.homedir(), …)` xử lý separator (Win/Mac/Linux). Đường dẫn `stdio.js` build từ `REPO_ROOT` (tuyệt đối) nên đúng bất kể cwd của agy.

**`config-page.js` tab AGY — cập nhật block CLI cho khớp:**

- `agyJson` (copy fallback) đổi sang dạng stdio: `{ mcpServers: { [AGY_SERVER_KEY]: { command: 'node', args: [<repoRoot>/scripts/stdio.js] } } }` (dùng `repoRoot` đã truyền vào `renderPanel`). Bỏ `httpUrl`/`Bearer`.
- Helptext CLI: đổi target file thành `~/.gemini/config/mcp_config.json`, nói rõ đây là entry **stdio** spawn `scripts/stdio.js` (vì `/mcp` Bearer-gated), permissions ở `antigravity-cli/settings.json` qua pre-allow bên dưới.
- Nhãn button: `Apply to AGY CLI (mcp_config.json)`.

**`public/panel-client.js`** — key `agyApply` giữ nguyên (chỉ gọi route + hiện message).

### Block "IDE" — resolved 2026-09-29: merged into the stdio entry

Evidence (live): `~/.gemini/antigravity/mcp_config.json` is a symlink to `~/.gemini/config/mcp_config.json` (created May 20, with the IDE's own data dir). Launching Antigravity IDE with `--remote-debugging-port` and an isolated `--user-data-dir` made its bundled `language_server_macos_arm` spawn `node scripts/stdio.js` from that file (two child processes, parent = the language server). The bundle also ships `McpServerCommandSchema` next to `McpRemoteServerSchema`. So one stdio entry serves CLI and IDE; the separate `serverUrl` + Bearer IDE block was removed from `config-page.js` (it overwrote the CLI entry and carried a rotating token).

---

## Problem 2 — Permission: AGY hỏi quyền từng tool mỗi lần gọi

### Fix — một entry wildcard, một hằng số tên server (KHÔNG đổi so với v1, đã xác minh đúng)

AGY hỗ trợ wildcard cả server: `mcp(akimcp/*)` auto-approve mọi tool. Route ghi đúng một entry này vào `settings.json` (bước B ở Problem 1), dedup bằng `Set` → idempotent, không phình `permissions.allow`, không đụng các entry khác.

**Trade-off an ninh (có chủ đích):** `mcp(akimcp/*)` tin cả server — gồm `run_cmd`, `write_file`, `edit_file`, `kill_port`, `chrome_launch`… chạy không hỏi. Chấp nhận vì server đã có phòng thủ lớp riêng (shell allowlist + roots), và nhất quán với cách Claude Code/Cursor được cấu hình. Đây là quyết định "tin cả server aki trong AGY".

---

## Files cần sửa

| File | Thay đổi |
|---|---|
| `scripts/stdio.js` | (Prereq, đã làm) Tạo lại stdio entry in-process. |
| `scripts/panel.js` | Đổi route `POST /api/agy-apply-mcp`: ghi entry **stdio** `{ command:'node', args:[REPO_ROOT/scripts/stdio.js] }` vào `~/.gemini/config/mcp_config.json`; dọn entry `akimcp` cũ (nếu có) dưới `mcpServers` của `settings.json`; giữ pre-allow `mcp(akimcp/*)` vào `settings.json`. Bỏ token/localUrl khỏi route. |
| `scripts/config-page.js` | `agyJson` → dạng stdio (dùng `repoRoot`); helptext CLI đổi file đích + mô tả stdio; nhãn button `Apply to AGY CLI (mcp_config.json)`. Block IDE: chưa đụng (open question). |
| `public/panel-client.js` | Không đổi (key `agyApply` đã gọi đúng route). |

---

## Checklist

- [x] Route ghi 2 file: `mcp_config.json` (server stdio) + `settings.json` (chỉ pre-allow), mỗi file đọc/ghi thẳng path của nó — KHÔNG dùng `readSettings()`/`SETTINGS_PATH` (đó là settings của panel).
- [x] Entry stdio dùng `path.join(REPO_ROOT, 'scripts', 'stdio.js')` (tuyệt đối, cross-platform).
- [x] Deep-merge `mcpServers` (giữ `playwright`/server khác), không gán đè cả object.
- [x] File chưa tồn tại → `{}`; `permissions` thiếu → `{ allow: [], deny: [] }`.
- [x] Dùng `writeJsonAtomic` (đã tự `mkdir -p`).
- [x] Dọn `settings.mcpServers.akimcp` cũ (self-healing cho ai đã bấm bản v1).
- [x] `AGY_SERVER_KEY` là SSoT cho cả `mcpServers` key lẫn `mcp(<key>/*)`.
- [x] Test end-to-end: sau Apply, chạy `agy` → `akimcp` Connected + gọi 1 tool không popup (đã xác minh 1 lần thủ công; lặp lại sau khi route ghi tự động).
- [x] Test idempotent: Apply 2 lần → `mcp_config.json` chỉ 1 entry `akimcp`, `permissions.allow` chỉ 1 wildcard (không nhân đôi), `playwright` còn nguyên.
- [x] Test Windows/Linux: `path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json')` resolve đúng.
- [x] Quyết open question block IDE: **Decided:** gộp về một entry stdio, bỏ block IDE `serverUrl` · because IDE language server spawn `stdio.js` từ cùng file (xác minh live) · rejected tách key (thừa entry), giữ nguyên (đè entry CLI) · reopen if IDE ngừng đọc `mcp_config.json`.

Bằng chứng 2026-09-29: gọi thẳng `ROUTES['POST /api/agy-apply-mcp']` hai lần với `HOME` giả (playwright + allow `other` + `akimcp` cũ trong settings) → `mcp_config.json` giữ `playwright` và có đúng 1 `akimcp` stdio, `permissions.allow` = `[other, mcp(akimcp/*)]` không nhân đôi, `settings.mcpServers.akimcp` bị dọn. Đường dẫn dựng bằng `path.join(os.homedir(), …)` nên đúng trên Win/Linux (đọc code). Kết nối agy thật đã xác minh tay ở mục 6 phần Bằng chứng.

---

## Đã loại khỏi plan (so với bản trước)

- Ghi `httpUrl`/`serverUrl` + Bearer vào `settings.json` — sai file + sai transport, đã thay bằng stdio → `mcp_config.json`.
- Danh sách ~39 tool hardcode / hằng `AKIMCP_TOOLS` / node snippet dump runtime — thừa vì đã dùng wildcard `mcp(akimcp/*)`.
- Mục "thêm mkdirSync thủ công" — `writeJsonAtomic` đã lo.
