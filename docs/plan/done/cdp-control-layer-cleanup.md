# Plan: Dọn lớp điều khiển CDP/Postman — tên đúng bản chất, bỏ indirection, gom hợp đồng

> **Trạng thái**: DONE, ship trong 2.2.0 (2026-10-01). #1, #2, #5 xong 2026-09-29; #3 xong 2026-09-27; #6 xong trong commit `53438c1` (`normalizeOwnershipStatus` ở `scripts/postman/postman-ownership.cjs`, cả daemon lẫn `postman-mcp.js` dùng chung); #4 có plan riêng (`done/unify-datadir-drop-legacy.md`); #7 thuộc repo khác.
> **Phạm vi**: lớp điều khiển CDP của Postman trong `scripts/postman/` + `scripts/cdp-engine.js`. KHÔNG đụng logic ownership đã có test, KHÔNG đổi hành vi quan sát được của tool.
> **Governing rules**: `pattern.A1` (một nguồn sự thật, không định nghĩa lại nhiều nơi), `coding.C4` (đổi trạng thái bền vững phải có migration/tương thích), `agent.B5` (chờ owner duyệt trước khi thực thi).
> **Nguồn phát hiện**: review 2026-09-27 trên working tree hiện tại; mọi mục dưới đây kèm `file:line` đã đối chiếu code + runtime (endpoint CDP `:55976`, 13 target → 3 `page`).

## Bối cảnh
Lớp này nhìn chung **rất chắc** và cố ý giữ nguyên: tách tầng `cdp-engine.js` (app-agnostic, kết nối ngắn, không giữ ownership) ↔ `postman-*` (app-specific); `postman-ownership.cjs` thuần hàm + có unit test; `readDevToolsPort` trả `null` trung thực thay vì đoán cổng 9222. Plan này **chỉ dọn phần rìa**: tên gây hiểu nhầm, indirection chết, hợp đồng khai báo 2 nơi, và chi phí thừa lúc khởi động.

Mục **#4 (hợp nhất data-dir, bỏ `LEGACY_CDP_DIR`)** đã có plan riêng — xem [`docs/plan/done/unify-datadir-drop-legacy.md`](./unify-datadir-drop-legacy.md). Không lặp lại ở đây.
Mục **#7 (14 bản `harness-facts.md`)** thuộc repo khác (`akidevrule`) — ghi ở cuối như finding, không có action trong repo này.

---

## #2 — Đổi tên `attachedWindowCount` → `attachedPageCount` (ưu tiên cao nhất)

> **ĐÃ THỰC HIỆN 2026-09-29** — đổi field ở writer `postman-daemon.cjs:462`, reader `postman-mcp.js:65`, panel `public/panel-client.js:265` + 2 test. Nhãn hiển thị `public/panel-client.js:266` vẫn giữ chữ "Postman window(s)" (chỉ đổi field, chưa đổi copy — chờ quyết định UX).

**Vấn đề**: Trường này đếm **page target đủ điều kiện**, KHÔNG phải cửa sổ (BrowserWindow) của OS. Tên "window" là bẫy nhận thức có thật — chính nó gây hiểu nhầm khi đọc `postman_status` (3 "window" thực ra là 3 page trong khi endpoint có 13 target: 3 page + 2 iframe + 1 service_worker + 7 worker).

**Blast radius** (hợp đồng cross-process qua `ownership-status.json` → phải đổi đồng bộ):
| File | Dòng | Nội dung |
|---|---|---|
| `scripts/postman/postman-daemon.cjs` | 462 | `attachedPageCount: attachedTargetIds.size` (trong `writeOwnershipStatus`) |
| `scripts/postman/postman-mcp.js` | 65 | `attachedWindowCount: ownership?.attachedWindowCount \|\| 0` (reader cho tool `postman_status`) |
| `scripts/postman/test/postman-status.test.js` | 15, 27, 35 | assertions |
| `scripts/postman/test/postman-panel-ownership.test.js` | 7 | `assert.match(source, /status\.attachedWindowCount/)` |
| `public/panel-client.js` | 265, 266 | reader field + nhãn "attached to N Postman window(s)" |

**Các bước**:
1. Đổi field trong `writeOwnershipStatus` → `attachedPageCount`.
2. Đổi reader `postman-mcp.js:65` + mọi nơi đọc.
3. (coding.C4) `ownership-status.json` là file tạm tái sinh mỗi tick 1s → **không cần migration**: daemon ghi đè trong ≤1s sau khi chạy. Chỉ cần release đồng thời daemon + reader để không lệch một nhịp.
4. Cập nhật 2 test + nhãn panel.

---

## #1 — Bỏ `attachmentTargets` (alias chết của `eligibleTargets`)

> **ĐÃ THỰC HIỆN 2026-09-29 (hướng A — inline)** — xoá hàm + export ở `postman-ownership.cjs`, bỏ khỏi import daemon, thay 2 call site (`discover` L494, `main` L566) bằng `eligibleTargets`; cập nhật test `postman-ownership.test.cjs`.

**Vấn đề**: `scripts/postman/postman-ownership.cjs`:
```js
function attachmentTargets(targets, isEligible) { return eligibleTargets(targets, isEligible); }
```
Zero hành vi thêm — chỉ là một lớp gián tiếp. Dùng ở `postman-daemon.cjs` (`discover()` ~L543, `main()` ~L615), export ở `module.exports`, và test `postman-ownership.test.cjs` import nó.

**Quyết định cần owner chọn (2 hướng, `pattern.A1`)**:
- **A — Inline**: thay 2 call site bằng `eligibleTargets`, bỏ khỏi export + test. Ít khái niệm hơn.
- **B — Giữ làm seam có chủ đích**: nếu định để "danh sách gắn CDP" tách khỏi "danh sách xét owner" trong tương lai, thì **giữ nhưng thêm 1 dòng comment nêu rõ lý do** (hiện chưa có → đọc code tưởng là thừa).

**Đề xuất**: hướng A, vì hiện tại attach-set và eligible-set là **cùng một tập** (cả `discover` lẫn `main` đều `setupCDP` đúng các eligible page); chưa có nhu cầu phân kỳ.

---

## #5 — Dedupe trích xuất token + refresh usage khi khởi động (không refresh ×3)

> **ĐÃ THỰC HIỆN 2026-09-29** — thêm `ensureUsageData()` (`postman-daemon.cjs`): gom in-flight + bỏ qua khi token không đổi; gate `saveAkiData` theo token đổi; `main` dùng `ensureUsageData`; binding refresh thủ công vẫn gọi thẳng `refreshUsageData` (ép fetch). Cold start N+1 → 1 call.

**Vấn đề**: `setupCDP` (`postman-daemon.cjs` ~L377+) chạy cho **mọi** eligible page (hiện 3): mỗi page đọc `localStorage.access_token` → `saveAkiData()` + `refreshUsageData(token).then(pushUsageToPage)`. → lúc khởi động có thể **3 lần đọc token + tới 3 lần gọi mạng `refreshUsageData`** cho cùng một token/tài khoản.

**Lưu ý (đừng làm hỏng chủ đích)**: gắn CDP + hook usage SSE lên cả 3 page là **có lý do** (token/SSE có thể xuất hiện ở page bất kỳ). Chỉ tối ưu phần **thừa**, không cắt phần phòng thủ.

**Các bước**:
1. Chỉ `saveAkiData` + `refreshUsageData` khi token **khác** token đang lưu (so với `loadAkiData()` hiện có) → idempotent.
2. Nếu nhiều page báo cùng token trong một đợt khởi động, chỉ gọi `refreshUsageData` **một lần** (guard bằng cờ in-flight hoặc so token).
3. Giữ nguyên `hookChatUsageCapture` trên mọi page (không đụng).

---

## #6 — Gom hợp đồng status về một nguồn (`pattern.A1`)

**Vấn đề**: shape của ownership-status khai báo **2 nơi**:
- `postman-daemon.cjs` `writeOwnershipStatus` (~L504–522) — nơi GHI.
- `postman-mcp.js` (~L60–66) — nơi ĐỌC, dựng lại object với `|| null` / `|| 0`.
Thêm/bớt field phải sửa 2 chỗ, dễ lệch.

**Các bước**:
1. Tạo một helper/kiểu chung mô tả shape (ví dụ `postman-ownership-status.cjs` export `normalizeOwnershipStatus(raw)` với default an toàn) — cả writer lẫn reader dùng chung.
2. Daemon CommonJS không import được ESM `userdata.js`, nên đặt helper ở `.cjs` để cả hai phía require được.
3. Reader `postman-mcp.js` thay khối `|| null`/`|| 0` bằng lời gọi normalize.

---

## #3 — Bỏ hẳn instrumentation "usage theo lượt" (ĐÃ THỰC HIỆN 2026-09-27)

> **Quyết định của owner: bỏ hẳn, không env-gate.** Lý do đã xác minh: tín hiệu **KHÔNG CHÍNH XÁC**. Event SSE `usage` là **credit pool theo tuần của cả team** (millicredit, `isTeamPooled=true`), dùng chung cho mọi thành viên và mọi hội thoại — nên delta mỗi lượt bị lẫn spend của người khác / hội thoại khác, không thể tách riêng context của một chat. Chính `docs/research/session-context-capture.md` §6 từ đầu đã **Ruled out** cách này; thí nghiệm usage-turn (thêm ở 2.1.0) là bước đi ngược kết luận đó, nay gỡ bỏ.

> **KHÔNG nhầm với thanh đo context.** Đo context = `readConversationChars`/`renderContextBar` (đếm ký tự DOM hội thoại) — là việc riêng, đã **khôi phục** cùng ngày (xem Amendments của research doc). Việc bỏ usage-turn không đụng đến thanh đo context.

**Đã gỡ khỏi `scripts/postman/postman-daemon.cjs`**:
- Hằng: `TURN_LOG_PATH`, `convoState`, `lastGlobalUsageMilli` + comment "Per-turn usage instrumentation".
- Hàm `logUsageTurn(...)` (toàn bộ) + lời gọi trong `applyChatUsageFromSSE`.
- Nhánh chỉ phục vụ log: parse event `conversation` trong `applyChatUsageFromSSE`, và trích `reqConvoId`/`reqModel` (kèm `getRequestPostData`) trong `hookChatUsageCapture`.
- Sửa comment L35 bỏ `usage-turns`.

**Giữ nguyên** (không đụng): `team.quota` + `pushUsageToPage` (hiển thị credit/limit trên panel) và hook SSE `usage` — đây là tính năng thật.

**Dọn kèm (tùy, runtime data)**: file `~/.aki/cdp-postman/usage-turns.jsonl` đã sinh ra trước đó có thể xoá thủ công — không phải code, không ảnh hưởng.

---

## #7 — Finding (không action trong repo này): 14 bản `harness-facts.md` được tạo thế nào

**Kết luận: KHÔNG phải lỗi lặp file.** Đây là **fanout có chủ đích từ 1 nguồn**, do installer của repo **khác** (`akidevrule`) thực hiện — nằm ngoài aki-mcp-sv.

**Cơ chế (đã xác minh)**:
- **Nguồn duy nhất (SSoT)**: repo `akidevrule` tại `/Volumes/DEV/AkiDevRule` (mirror cài đặt ở `~/.aki/akidevrule`, xem `~/.aki/akidevrule/.source-repo` = `/Volumes/DEV/AkiDevRule`, `.version` = `3.4.0 commit 4de8866`). Skill gốc: `agskills/akiflow/references/harness-facts.md`.
- **Installer**: `install.mjs`/`install.sh` của akidevrule. Hàm `getClaudeDirs()` tự dò **mọi** thư mục `~/.claude*` dưới `$HOME` (tôn trọng `$CLAUDE_CONFIG_DIR`, `--claude-dir`, dedupe theo canonical path), rồi **đồng bộ skills/agents/hooks/CLAUDE.md/settings.json sang tất cả profile trong một lượt cài** (theo `~/.aki/akidevrule/CHANGELOG.md`). Ngoài Claude còn ghi vào `~/.gemini/config/`, `~/.kiro/`, `~/.grok/`, `~/.agents/`.
- **Vì sao phải là bản sao thật (không symlink)**: mỗi AI CLI **chỉ đọc skill từ config-root riêng của nó** → mỗi profile cần một bản trong `skills/` của chính mình.
- **Vì sao 14**: 1 mirror nguồn (`~/.aki/akidevrule/agskills/…`) + ~10 profile CLI (`~/.claude`, `~/.claude-9rt`, `~/.claude-lva`, `~/.claude-prx`, `~/.claude-prx-dev`, `~/.claude-tom`, `~/.claude-work`, `~/.grok`, `~/.kiro`, `~/.gemini/config`, `~/.agents`) + 2 vị trí plugin của Claude app (`~/.claude/skills/synced/<uuid>/…` và `~/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/…`).
- **Bằng chứng "một lượt"**: tất cả bản có **cùng size `41059` và cùng mtime `2026-09-27 05:44`**, trùng `installed=2026-09-27 05:44:57` trong `.version` → viết cùng một lần cài từ một nguồn.

**Rủi ro duy nhất**: nếu ai đó lỡ **sửa tay một bản đích** thay vì sửa `/Volumes/DEV/AkiDevRule` rồi cài lại → drift âm thầm. Khuyến nghị (thuộc akidevrule, không thuộc plan này): coi mọi bản đích là **read-only sinh ra**, chỉ sửa ở source repo.

---

## Thứ tự đề xuất
1. **#2** (đổi tên) + **#4** (đã có plan) đi cùng release — cả hai đụng `ownership-status.json`, gộp một nhịp để reader/writer không lệch.
2. **#3** (env-gate usage log) — độc lập, rủi ro thấp, làm sớm để cắt I/O thừa.
3. **#6** (gom hợp đồng status) — làm sau #2 để normalize luôn tên field mới.
4. **#1** (bỏ alias) + **#5** (dedupe token/refresh) — dọn nhỏ, làm bất cứ lúc nào.

## Kiểm thử / postcondition
- `npm test` xanh, đặc biệt `postman-ownership.test.cjs`, `postman-status.test.js`, `postman-panel-ownership.test.js` (cập nhật theo tên field mới ở #2).
- `postman_status` sau khi chạy vẫn trả đúng số page (`attachedPageCount`), `ownerTargetId` không đổi hành vi (vẫn là eligible page có id nhỏ nhất).
- Không còn sinh `usage-turns.jsonl`; `node --check postman-daemon.cjs` pass; panel usage (credit/limit) vẫn hiển thị; thanh đo context (`#aki-ctx-bar`) hiển thị trở lại ở footer chat.
