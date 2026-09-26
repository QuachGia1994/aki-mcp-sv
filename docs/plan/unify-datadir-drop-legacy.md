# Plan: Zero-legacy — hợp nhất data-dir về `~/.aki/mcpsv` + bỏ mọi fallback prompt

Kế thừa & mở rộng `docs/plan/done/instructions-prompts-refactor.md` (refactor tiền nhiệm — plan đã hoàn tất & đưa vào `done/`; nó cố ý xếp việc hợp nhất `~/.aki/cdp-postman` → `~/.aki/mcpsv` vào mục *No action*). Plan này thực hiện đúng phần bị hoãn đó theo yêu cầu owner: **không giữ bất kỳ legacy nào, gọn sạch.**

> Read-only research, CHƯA triển khai. Đọc code tại working tree 1.14.0 + refactor chưa commit (2026-09-05).

## Mục tiêu
- Một thư mục writable duy nhất: `~/.aki/mcpsv` (`$AKI_DATA_DIR`). Xoá hẳn `~/.aki/cdp-postman`.
- Load chain prompt còn **2 bước**: `$AKI_DATA_DIR/prompts/<provider>.md` → `prompts/<provider>.md` (bundled default). Bỏ 2 fallback legacy.
- Xoá seed legacy trong repo (`scripts/postman/data/`) + dọn `.gitignore`.
- KHÔNG đổi nội dung prompt (bản v3 Claude-Code-style đã nằm sẵn ở cả asset + live) và KHÔNG đổi tên provider (giữ `postman`).

## Bối cảnh — blast radius (đã grep, file:line)

Còn trỏ `~/.aki/cdp-postman` (cụm `data.json` / `daemon.pid` / `new-window.flag` / `postman-usage` — cross-process):

| File | Dòng | Nội dung |
|---|---|---|
| `scripts/postman/postman-daemon.cjs` | 39–42, 164, 196–199, 225–226 | `LEGACY_CDP_DIR`, `DATA_JSON_PATH`, `LEGACY_INSTRUCTION_PATH`, `LEGACY_REPO_INSTRUCTION_PATH`, `NEW_WINDOW_FLAG_PATH`, load chain, `saveAkiData` mkdir |
| `scripts/postman/postman-mcp.js` | 17–18 | `DATA_JSON_PATH`, `NEW_WINDOW_FLAG_PATH` (reader — main server / tool `postman_status`) |
| `scripts/postman/postman-usage.cjs` | 11 | `AKI_DATA_JSON` (reader) |
| `scripts/postman/postman-daemon-pid.cjs` | 5 | `PID_PATH` |

Đã ở `~/.aki/mcpsv` (SSoT đích, không đụng): `scripts/userdata.js:7` (`USER_DIR` + oauth/settings/tokens), `postman-daemon.cjs:26` (`AKI_DATA_DIR`, prompts), `update-check.js:15`.

⚠️ **`data.json` là hợp đồng cross-process:** daemon GHI (`postman-daemon.cjs` `saveAkiData`), main server + usage ĐỌC (`postman-mcp.js`, `cdp-usage.js`). Đổi path phải sửa **đồng bộ cả 4 file cùng lúc**, lệch một chỗ → `postman_status` / usage / new-window / pid mồ côi.

## Trước → Sau

| | BEFORE | AFTER |
|---|---|---|
| Home dir | `~/.aki/cdp-postman/` (data.json, pid, flag, usage) **+** `~/.aki/mcpsv/` (prompts, oauth…) | **chỉ** `~/.aki/mcpsv/` (tất cả) |
| Prompt default (tracked) | `scripts/postman/prompts/postman.md` | giữ nguyên |
| Prompt user/live | `~/.aki/mcpsv/prompts/postman.md` | giữ nguyên |
| Load chain | USER → LEGACY_CDP → LEGACY_REPO → DEFAULT (4) | **USER → DEFAULT (2)** |
| Repo legacy seed | `scripts/postman/data/aki-postman-instruction.md` (gitignored) | **xoá** |

## Các bước

### A. Prompt — bỏ 2 fallback legacy
- `scripts/postman/postman-daemon.cjs`: xoá hằng `LEGACY_INSTRUCTION_PATH` (L41), `LEGACY_REPO_INSTRUCTION_PATH` (L42); `loadInstructionFile()` (L196–199) chỉ còn `loadInstruction([USER_PROMPT_PATH, DEFAULT_PROMPT_PATH])`.
- `scripts/postman/postman-instruction-store.cjs`: `loadInstruction` đã nhận mảng path — không đổi logic, chỉ nhận 2 phần tử.

### B. Hợp nhất data-dir → `~/.aki/mcpsv` (sửa đồng bộ 4 file)
- `postman-daemon.cjs`: xoá `LEGACY_CDP_DIR` (L39); `DATA_JSON_PATH`, `NEW_WINDOW_FLAG_PATH` trỏ `AKI_DATA_DIR` (`~/.aki/mcpsv`); `saveAkiData` (L225–226) mkdir `AKI_DATA_DIR` (đưa vào `init()` đã có, không mkdir rải rác).
- `scripts/postman/postman-mcp.js` (L17–18): `DATA_JSON_PATH = ~/.aki/mcpsv/data.json`, `NEW_WINDOW_FLAG_PATH` theo dirname.
- `scripts/postman/postman-usage.cjs` (L11): `AKI_DATA_JSON = ~/.aki/mcpsv/data.json`.
- `scripts/postman/postman-daemon-pid.cjs` (L5): `PID_PATH = ~/.aki/mcpsv/daemon.pid`.
- (Tùy) rút path cứng lặp lại về một hằng chung để tránh 4 nơi định nghĩa lại (`pattern.A1`) — daemon CommonJS không import được `userdata.js` (ESM), nên dùng một hằng nội bộ `~/.aki/mcpsv`.

### C. Xoá seed legacy repo + `.gitignore`
- Xoá file + thư mục `scripts/postman/data/`.
- `.gitignore`: bỏ dòng `data/` (không còn dùng ở repo này) — xác minh không còn thư mục `data/` hợp lệ nào khác trước khi bỏ.

### D. Docs
- `CLAUDE.md` § "Process topology": bỏ đoạn mô tả `~/.aki/cdp-postman` giữ `data.json/daemon.pid/new-window.flag` và câu "unifying the two dirs is a deliberate follow-up, not done here" → mô tả một dir duy nhất `~/.aki/mcpsv`.
- `README.md`: cập nhật directory layout (chỉ `~/.aki/mcpsv`).
- `docs/index.md`: thêm entry cho plan này (A1) — làm ở bước thực thi, không nằm trong "1 file plan" hiện tại.

### E. Test
- `scripts/postman/test/postman-daemon-copy.test.js`: bỏ assertion về load chain legacy; assert chain mới `[USER, DEFAULT]`; assert `data.json` / `daemon.pid` / `new-window.flag` ở `~/.aki/mcpsv`; giữ assert `AKI_DATA_DIR`/`PROMPTS_DIR` (L44–45).

## Cái giá (chấp nhận theo yêu cầu zero-legacy)
- **Không migrate:** `~/.aki/cdp-postman/data.json` (`access_token`, config) bị bỏ → lần chạy đầu sau đổi phải login / set lại config. Đây là đánh đổi cố ý của "no legacy".
- Thực hiện **khi daemon đã tắt** (tránh mồ côi pid/flag theo path cũ).

## Files thay đổi (full path)
- `/Volumes/DEV/pj/aki-mcp-sv/scripts/postman/postman-daemon.cjs`
- `/Volumes/DEV/pj/aki-mcp-sv/scripts/postman/postman-instruction-store.cjs`
- `/Volumes/DEV/pj/aki-mcp-sv/scripts/postman/postman-usage.cjs`
- `/Volumes/DEV/pj/aki-mcp-sv/scripts/postman/postman-daemon-pid.cjs`
- `/Volumes/DEV/pj/aki-mcp-sv/scripts/postman/postman-mcp.js`
- `/Volumes/DEV/pj/aki-mcp-sv/.gitignore`
- `/Volumes/DEV/pj/aki-mcp-sv/CLAUDE.md`
- `/Volumes/DEV/pj/aki-mcp-sv/README.md`
- `/Volumes/DEV/pj/aki-mcp-sv/scripts/postman/test/postman-daemon-copy.test.js`
- xoá: `/Volumes/DEV/pj/aki-mcp-sv/scripts/postman/data/` (toàn thư mục)

## Ngoài phạm vi
- Đổi tên provider `postman` ↔ `aki-postman` (giữ `postman`).
- Nội dung prompt (đã ghi ở turn trước, không đụng).
- Predecessor `docs/plan/done/instructions-prompts-refactor.md`: plan đã hoàn tất & đưa vào `done/`; code refactor vẫn đang chờ commit — chỉ tham chiếu, không sửa nội dung lịch sử.

## Verification (coding.B3 — tĩnh trước, không chạy app trừ khi cần)
- `node --check` trên mọi JS đã sửa.
- `node scripts/postman/test/postman-daemon-copy.test.js` (dùng `AKI_DATA_DIR`=tempdir qua env).
- `grep -rn "cdp-postman" scripts/` → phải trả về 0 (chứng minh sạch legacy).
- `git diff --check`; review toàn bộ diff.

## Ràng buộc vận hành
- Không commit/push/deploy/cài dependency/mở folder-picker.
- Khi commit (bước riêng, cần owner duyệt): thêm `CHANGELOG.md` + drift-check `config-page.js` / `README.md` / `docs/index.md` (theo repo `CLAUDE.md` + `RULE-release.md`).

## Open questions
- Bỏ luôn dòng `data/` trong `.gitignore`? Đề xuất: có (không còn dùng).
- Dọn `~/.aki/cdp-postman` trên máy dev bằng `rm`, hay để user tự xoá? Đề xuất: để user; plan chỉ nêu.
