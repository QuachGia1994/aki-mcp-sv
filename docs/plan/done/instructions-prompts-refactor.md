# Plan: Refactor instructions & prompts — Aki Postman Control Panel (done)

Gộp yêu cầu sửa lỗi lưu prompt với kế hoạch REFACTOR. Phạm vi: instructions/prompts của daemon `scripts/aki-pmcontrol/` (CDP-driven Postman control), không đụng usage/autoclick logic ngoài phần thêm nút "Send to chat".

> **Trạng thái**: Đã hoàn thành (2026-09-06). Provider chính thức chốt là `postman` (`postman.md`).

## Mục tiêu

- Chuyển mô hình lưu prompt từ single-file (`aki-postman-instruction.md`) sang directory-based `prompts/<provider>.md`.
- Chuẩn hoá thư mục writable về `$AKI_DATA_DIR` (mặc định `~/.aki/mcpsv`), khớp `scripts/userdata.js` (`USER_DIR = ~/.aki/mcpsv`) của server chính.
- Giữ markdown trong repo là **default asset read-only**; mọi ghi của user chỉ vào `$AKI_DATA_DIR`.
- Thêm prompt dùng chung `aki-prompt-sum-to-new-chat.md` và nút **"Send to chat"** trong panel CDP.

## Bối cảnh hiện tại (đã đọc code, 2026-09-05)

- Daemon `scripts/aki-pmcontrol/index.js` là bản copy CommonJS; quản lý instruction qua `scripts/aki-pmcontrol/scripts/instruction-store.js`.
- Path instruction trong `index.js`:
  - writable: `USER_PROMPT_PATH = ~/.aki/mcpsv/prompts/postman.md` (const `AKI_DATA_DIR = ~/.aki/mcpsv`).
  - legacy read (cdp-postman, chỉ đọc): `LEGACY_INSTRUCTION_PATH = ~/.aki/cdp-postman/aki-postman-instruction.md`.
  - legacy read (repo, chỉ đọc): `LEGACY_REPO_INSTRUCTION_PATH = scripts/aki-pmcontrol/data/aki-postman-instruction.md`.
  - bundled default (repo, read-only): `DEFAULT_PROMPT_PATH = scripts/aki-pmcontrol/assets/prompts/postman.md`.
- `instruction-store.js`: `loadInstruction([paths])` trả bản non-empty đầu tiên theo thứ tự mảng; `saveInstruction(userPath, text)` tự `mkdirSync(dirname)` rồi ghi; `copyDefaultIfMissing(targetPath, defaultPath)` copy template nếu chưa có hoặc rỗng.
- Panel UI được inject bởi `scripts/aki-pmcontrol/scripts/cdp-autoclicker.js`; lưu instruction đi qua CDP binding `__cdpSaveInstruction`. `index.js` đăng ký binding tại `setupCDP` và xử lý ở `bindingCalled`.
- Thêm binding `__cdpSendToChat` để gửi shared prompt `aki-prompt-sum-to-new-chat.md` vào chat input qua `typeAndSubmitChat`.

## Nguyên tắc (ràng buộc bất biến)

1. Markdown trong repo (`scripts/aki-pmcontrol/assets/…`) = default asset **read-only**, không bao giờ ghi đè.
2. Tuyệt đối không ghi vào `scripts/aki-pmcontrol/data/` — chỉ đọc như legacy fallback.
3. Writable/user data chỉ ở `$AKI_DATA_DIR` (mặc định `~/.aki/mcpsv`), tự tạo thư mục cha.
4. Copy default không được đè bản user đã sửa (`~/.aki/mcpsv/prompts/*` non-empty thì giữ nguyên).
5. `<provider>` là tên role, không hard-code giá trị rải rác (`pattern.A7`) — một hằng số nguồn (`PROVIDER = 'postman'`).

## Layout

| Vai trò | Đường dẫn |
|---|---|
| Bundled default (read-only source) | `scripts/aki-pmcontrol/assets/prompts/<provider>.md` (`postman.md`) |
| Shared prompt (read-only source) | `scripts/aki-pmcontrol/assets/prompts/aki-prompt-sum-to-new-chat.md` |
| Writable per-provider | `$AKI_DATA_DIR/prompts/<provider>.md` (`~/.aki/mcpsv/prompts/postman.md`) |
| Writable shared | `$AKI_DATA_DIR/prompts/aki-prompt-sum-to-new-chat.md` |
| Legacy dir cũ (chỉ đọc, migrate) | `~/.aki/cdp-postman/aki-postman-instruction.md` |
| Legacy repo data (chỉ đọc) | `scripts/aki-pmcontrol/data/aki-postman-instruction.md` |

Quy ước tên: provider prompt = `prompts/<provider>.md` (provider: `postman`); shared prompt giữ nguyên tên literal `aki-prompt-sum-to-new-chat.md`.

## Các bước thực thi đã hoàn tất

### 1. Data-dir resolution trong daemon (`index.js`)
- Giới thiệu writable dir mới: `AKI_DATA_DIR = process.env.AKI_DATA_DIR || path.join(os.homedir(), '.aki', 'mcpsv')`.
- Đổi tên hằng cũ `~/.aki/cdp-postman` thành `LEGACY_CDP_DIR` (chỉ dùng cho đọc migrate + các file data.json/pid/flag hiện có).
- Định nghĩa `PROMPTS_DIR = path.join(AKI_DATA_DIR, 'prompts')`, `ASSETS_PROMPTS_DIR = path.join(__dirname, 'assets', 'prompts')`, hằng `PROVIDER = 'postman'`, `SUM_PROMPT_NAME = 'aki-prompt-sum-to-new-chat.md'`.

### 2. `init()` — gom mọi mkdir + copy prompts (chạy lúc launch)
- Thêm `function init()` gọi ngay đầu `main()`: tạo `AKI_DATA_DIR`, `PROMPTS_DIR` bằng `mkdirSync(..., { recursive: true })`.
- Copy default: với mỗi file trong `ASSETS_PROMPTS_DIR`, nếu bản `$AKI_DATA_DIR/prompts/<file>` **chưa tồn tại hoặc rỗng** thì copy từ asset sang (không đè bản user).

### 3. Chuyển sang `prompts/<provider>.md` + load order
- `USER_PROMPT_PATH = path.join(PROMPTS_DIR, PROVIDER + '.md')`.
- `loadInstructionFile()` dùng load order (bản non-empty đầu tiên): `$AKI_DATA_DIR/prompts/<provider>.md` → `~/.aki/cdp-postman/aki-postman-instruction.md` (legacy dir cũ) → `scripts/aki-pmcontrol/data/aki-postman-instruction.md` (repo legacy, chỉ đọc) → `scripts/aki-pmcontrol/assets/prompts/<provider>.md` (bundled default).
- Module `instruction-store.js`: `loadInstruction([paths])`, `saveInstruction(userPath, text)`, `copyDefaultIfMissing(targetPath, defaultPath)`.

### 4. Save
- `saveInstructionFile(text)` chỉ ghi `$AKI_DATA_DIR/prompts/<provider>.md` qua `saveInstruction`.
- `saveInstruction` giữ `mkdirSync(dirname, { recursive: true })` để an toàn.

### 5. Shared prompt & "Send to chat" trong panel CDP
- Tạo `scripts/aki-pmcontrol/assets/prompts/aki-prompt-sum-to-new-chat.md` (không hard-wrap theo `agent.C3`).
- Nút "SEND TO CHAT" trong panel inject bởi `cdp-autoclicker.js`.
- Nút gọi binding `__cdpSendToChat` → daemon gửi prompt vào input qua `typeAndSubmitChat`.

### 6. Docs & Test
- `README.md` & `CLAUDE.md`: cập nhật layout `~/.aki/mcpsv/prompts/`.
- `test/aki-pmcontrol-copy.test.js`: test bộ load order, saveInstruction, copyDefaultIfMissing và UI binding assertions.

## Files thay đổi

- `/Volumes/DEV/pj/aki-mcp-sv/scripts/aki-pmcontrol/index.js`
- `/Volumes/DEV/pj/aki-mcp-sv/scripts/aki-pmcontrol/scripts/instruction-store.js`
- `/Volumes/DEV/pj/aki-mcp-sv/scripts/aki-pmcontrol/scripts/cdp-autoclicker.js`
- `/Volumes/DEV/pj/aki-mcp-sv/scripts/aki-pmcontrol/assets/prompts/postman.md`
- `/Volumes/DEV/pj/aki-mcp-sv/scripts/aki-pmcontrol/assets/prompts/aki-prompt-sum-to-new-chat.md`
- `/Volumes/DEV/pj/aki-mcp-sv/test/aki-pmcontrol-copy.test.js`
- `/Volumes/DEV/pj/aki-mcp-sv/README.md`
- `/Volumes/DEV/pj/aki-mcp-sv/CLAUDE.md`
