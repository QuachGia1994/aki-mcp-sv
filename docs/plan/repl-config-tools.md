# REPL bền phiên + get_config — mở rộng process-mcp

## Mục tiêu
Thêm khả năng chạy session tương tác bền (REPL Python/Node...) và tự dò môi trường (OS/shell/Python-Node version), học theo Desktop Commander (`start_process` / `interact_with_process` / `read_process_output`, `get_config`) — **không** đổi triết lý an toàn hiện có (whitelist thay vì blocklist, không shell thật, mọi request vẫn qua đúng 1 cổng gatekeeper).

**Ngoài phạm vi (c):** thêm lệnh *ghi* (`git commit`, `npm install`...). Allowlist read-only mở rộng được qua `~/.aki/mcpsv/setting.json` → `shell.allowlist`, nhưng defaults vẫn chỉ-đọc; thêm lệnh ghi vào đó là vượt ranh giới (c), cần plan bảo mật riêng.

## Ràng buộc bắt buộc
- Không thêm cổng mới, không đổi kiến trúc `gatekeeper → mcp-hub` hiện có — server mới vẫn spawn qua stdio, gộp vào `mcp-hub.config.json` như 2 server hiện tại.
- Không dùng shell thật (`/bin/sh`) để khởi tiến trình — dùng `spawn(bin, args)` trực tiếp, giữ nguyên tắc đã áp dụng cho `execFile` trong `shell-mcp.js`.
- Whitelist binary cho REPL **tách riêng** khỏi `ALLOWED` (whitelist đọc) — không dùng chung set, tránh 1 lệnh vô tình lọt cả hai nhóm quyền.
- Mọi tiến trình REPL bắt buộc có idle-timeout tự kill — server nghe từ internet công khai, không giới hạn = rủi ro giữ tài nguyên vô hạn nếu phiên bị bỏ quên hoặc có truy cập trái phép.
- Giới hạn số tiến trình đồng thời — tránh mở tràn lan session, đặc biệt qua truy cập từ xa không giám sát chặt theo thời gian thực.

## Quyết định kiến trúc

| Vấn đề | Quyết định | Vì sao |
|---|---|---|
| File mới hay mở rộng `shell-mcp.js` | File mới `scripts/process-mcp.js`, entry riêng trong `mcp-hub.config.json` | Giữ `shell-mcp.js` đúng tên gọi và đúng nghĩa "read-only" — không lẫn tiến trình sống (có thể nhận input tuỳ ý) vào cùng 1 file/tool. Khớp thói quen hiện có: mỗi concern 1 file (`oauth.js`, `gatekeeper.js`, `streamable-bridge.js`) |
| Cơ chế giữ tiến trình sống | `child_process.spawn`, lưu vào `Map<pid, ChildProcess>` trong bộ nhớ tiến trình `process-mcp.js` | Giống cơ chế 3 tool REPL của DC — cần state giữa nhiều lần gọi tool; `execFile` không làm được vì chạy xong là kết thúc, không giữ stdin mở |
| Tool mới | `start_process(command)`, `interact_with_process(pid, input)`, `read_process_output(pid)`, `kill_process(pid)` | Tối thiểu đủ để lái REPL. Không thêm `list_processes` ở bản đầu — 1 người dùng, ít session đồng thời, thêm sau nếu cần |
| Whitelist binary khởi động REPL | Set riêng, khởi điểm nhỏ: `python3 -i`, `node -i` (đúng chuỗi, không nhận thêm flag/arg từ input) | Học DC ở việc hỗ trợ REPL, nhưng không copy triết lý "chạy bất kỳ lệnh gì" — mỗi binary thêm sau phải cân nhắc riêng, không tự động mở rộng |
| Idle-timeout | Mặc định 20 phút không tương tác → tự `kill_process`, cùng mốc DC đang dùng cho session | Tránh treo tài nguyên vô thời hạn khi expose qua Funnel |
| Giới hạn đồng thời | Tối đa 3 tiến trình sống cùng lúc, vượt → từ chối `start_process` kèm thông báo rõ | MVP 1 người dùng, không cần nhiều; giới hạn thấp giảm rủi ro nếu bị lạm dụng |
| `get_config` | Tool mới, read-only, trả JSON `{platform, shell, pythonVersion, nodeVersion, repoRoot}` — `repoRoot` lấy từ `process.cwd()` lúc chạy, không hardcode | Rẻ, rủi ro gần 0. Gộp luôn `repoRoot` vì đây là kênh đáng tin duy nhất để 1 phiên Claude khác tự định vị repo — xem mục "`instructions` field — vì sao không dùng" bên dưới, không dùng README hay `instructions` field cho việc này |

## `instructions` field — vì sao không dùng

Spec MCP có field `instructions` ở `initialize` response (thiết kế để bơm context nền vào system prompt), SDK hỗ trợ. Nhưng **`mcp-hub@4.2.1` không forward** `instructions` từ server con ra client — set gì trong `shell-mcp.js` cũng bị chặn tại lớp aggregate. Ngay cả Claude Desktop cũng chưa đọc field này (`anthropics/claude-code#43749`).

**Quyết định:** dồn context vào `description` của tool — kênh duy nhất mọi client chắc chắn đọc (qua `tools/list`).

## Permission — quyết định

| Vấn đề | Quyết định | Cơ chế |
|---|---|---|
| Whitelist REPL | `python3 -i`, `node -i` — so khớp đúng chuỗi cố định, không parse arg tuỳ ý | trong code `process-mcp.js`, khác cách `shell-mcp.js` parse argv cho lệnh đọc |
| Idle-timeout | 20 phút, `setTimeout` reset mỗi lần `interact_with_process`/`read_process_output` gọi trúng `pid` | trong `process-mcp.js`, không cần dependency ngoài |
| Giới hạn đồng thời | 3 tiến trình, kiểm tra `Map.size` trước khi `spawn` mới | trong `process-mcp.js` |
| Buffer output | Giới hạn kiểu tương tự shell hiện có (~1MB), cắt bớt nếu vượt, báo rõ đã bị cắt | tránh 1 tiến trình in ra vô hạn làm phình bộ nhớ |

## Checklist thực thi
- [ ] `scripts/process-mcp.js` — `start_process`, `interact_with_process`, `read_process_output`, `kill_process`, `get_config`
- [ ] Thêm entry `process` vào `mcp-hub.config.json`
- [ ] Idle-timeout 20 phút + giới hạn 3 tiến trình đồng thời
- [ ] Test local: mở `python3 -i`, gửi lệnh, đọc kết quả; để idle quá 20 phút → tự kill; mở tiến trình thứ 4 → bị từ chối
- [ ] Test qua claude.ai thật (giống cách đã verify `shell__run_cmd`) — xác nhận tool mới xuất hiện trong `tools/list`
- [ ] Cập nhật `README.md` (mục kiến trúc + danh sách tool) sau khi verify xong

## Ngoài phạm vi (để sau)
- (c) Mở rộng khả năng ghi cho `shell-mcp.js` (vd `git commit`, `npm install`) — thuộc nhóm shell, đổi triết lý "chỉ đọc" hiện tại, cần plan bảo mật riêng.
- Đọc file cấu trúc (docx/xlsx/pdf) — giá trị thấp hơn cho use case hiện tại, chưa cần.

## Cross-references
- `docs/plan/init.md` — quyết định kiến trúc gốc (mcp-hub + gatekeeper + funnel)
- `docs/ref/security-model.md` — mô hình bảo mật OAuth hiện tại, không đổi bởi doc này
- `README.md` — setup; vị trí repo do panel tự in ra theo `process.cwd()`, repo đặt ở đâu cũng được

## Decision
**Action** → tạo `scripts/process-mcp.js` theo bảng trên, thêm entry vào `mcp-hub.config.json`, chưa động vào `shell-mcp.js`.
