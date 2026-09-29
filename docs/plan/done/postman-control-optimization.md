# Giám định & Kế hoạch Tối ưu: Kích hoạt Subagent Shell Native của Postman thay vì phụ thuộc 100% vào AKIMCP

> **Trạng thái**: **THÀNH CÔNG — đã chứng minh bằng ground-truth (Cập nhật 2026-09-27, phiên thực nghiệm thứ 2)**
> **Nguyên tắc tối thượng**: Không nhận vơ "thành công" trên câu chữ chat khi model chưa thực sự phát tool call qua Subagent Shell native.
> **Bằng chứng quyết định**: Prompt `hostname` (ngoài allowlist, output không thể bịa) qua fallback shell trả về đúng `Aki-MBA16.local` — khớp 100% với `hostname` chạy thật trên máy. Không phải hallucination.

---

## 1. Vấn đề Cốt lõi & Bối cảnh Thực tế

1. **Hiện tượng Postman bị AKIMCP "chiếm quyền"**:
   - Khi `aki-mcp-sv` kết nối vào Postman, catalog của AKIMCP (`aki__run_cmd`, `aki__read_text_file`...) xuất hiện trong danh sách công cụ quảng bá.
   - Postman Agent Mode bị thiên vị 100% vào `aki__run_cmd`. Hễ người dùng yêu cầu chạy lệnh shell, Postman lập tức tống qua `aki__run_cmd`.
   - Khi gặp một lệnh **ngoài allowlist / whitelist** của AKIMCP (hoặc các lệnh phức tạp cần piping, chaining, xử lý thông minh hơn), Postman lập tức đầu hàng, báo lỗi bị chặn an toàn hoặc từ chối thực hiện, thay vì biết dùng công cụ shell của chính mình.
   - **Thực tế đau đớn từ các lần test trước**: Model có thể "đồng ý bằng lời nói trong chat" rằng nó sẽ dùng subagent shell làm fallback, nhưng khi đưa lệnh vào chạy thật, **nó chưa bao giờ thực sự gọi Subagent Shell native mà vẫn 100% gọi `aki__run_cmd`**. Nhận "thành công" khi chỉ có lời hứa suông trong chat là sai lầm trầm trọng.

2. **Mục tiêu Tối thượng của Nhiệm vụ**:
   - Tối ưu hóa prompt trong [`scripts/postman/prompts/postman.md`](file:///Volumes/DEV/pj/aki-mcp-sv/scripts/postman/prompts/postman.md).
   - Khiến Postman **thực sự ý thức được việc nó sở hữu Subagent Shell native để chạy lệnh**, hiểu rằng nó có năng lực chạy lệnh shell qua Subagent native của chính nó chứ không phải chỉ thụ động chờ khi AKIMCP bị chặn.
   - Khi cần chạy lệnh (fallback khi AKIMCP không đáp ứng, ngoài allowlist, lệnh phức tạp hoặc khi được chỉ định), Postman phải **thực sự kích hoạt và gọi Subagent Shell native của nó để thực thi**, thay vì chỉ biết tống 100% vào `aki__run_cmd` rồi đầu hàng hoặc chỉ hứa miệng trong chat.

3. **Ràng buộc Bắt buộc & Định nghĩa Thành công/Thất bại**:
   - **Thước đo thành công duy nhất**: Postman phải **thực sự phát lệnh / kích hoạt Subagent Shell native** (`executeShellCommand` / subagent execution). Tuyệt đối KHÔNG chấp nhận nếu chỉ hứa mồm trên chat.
   - **Định nghĩa thất bại nghiêm trọng**: Nếu Postman vẫn tống lệnh qua `aki__run_cmd` khi được yêu cầu chạy bằng subagent shell, đó là **SAI MỤC TIÊU HOÀN TOÀN**.
   - **Keyword cốt lõi**: Bắt buộc luôn giữ chặt cặp keyword `subagent` + `shell` (hoặc `executeShellCommand`), tuyệt đối không được làm mờ hay quên.
   - **Focus tuyệt đối**: Tập trung 100% vào năng lực chạy shell của subagent nó. CẤM đưa các từ gây nhiễu (như Workspace, Collections, Postman APIs) vào prompt.
   - **An toàn nội dung**: Không prompt chạy lệnh nguy hiểm (chỉ dùng lệnh an toàn như `echo`, `pwd`).
   - **Quy tắc thao tác**: CẤM đọc thêm bất cứ file nào ngoài ngữ cảnh; bảo vệ an toàn tuyệt đối cho cửa sổ chính `AAC80E01`, chỉ thao tác trên cửa sổ test qua CDP.

---

## 2. FACT CỨNG Kiến trúc (Tuyệt đối Cấm quên)

1. **Postman KHÔNG BAO GIỜ chạy shell command trực tiếp ở parent chat**:
   - Khi hỏi trực tiếp parent agent ("Please run executeShellCommand", "Do you have executeShellCommand?"), model luôn luôn từ chối thẳng: *"No, I don't have executeShellCommand"*. Catalog trực tiếp của parent chat không có công cụ này.
   - Năng lực chạy lệnh native (`executeShellCommand`, `readFile`, `createFile`...) **CHỈ TỒN TẠI VÀ CHỈ ĐƯỢC PHÁT KHI GATEWAY ĐI VÀO SUBAGENT EXECUTION STATE** (`planningChunk.metadata.id = "sub-agent-execution-state"`).

2. **Hai keyword bắt buộc phải luôn đi song song: `Subagent` + `Command Execution`**:
   - Không bao giờ được bảo nó chạy command đơn lẻ ở parent chat (vì chắc chắn nó sẽ chối bỏ và fallback sang `aki__run_cmd`).
   - Phải luôn gắn quyền thực thi lệnh với Subagent (ví dụ: `subagent shell`, `subagent` thực thi lệnh).

3. **Rào cản Bộ lọc An toàn (`aether-banner` / Safety Filter)**:
   - Nếu đưa nguyên văn chuỗi wire protocol dạng kebab-case `sub-agent-execution-state` vào prompt người dùng, bộ lọc an toàn của Cloudflare / Gateway Postman sẽ **gắn cờ đỏ ngay lập tức (100% FLAGGED)**.
   - Nếu dùng các cụm từ kích hoạt vi phạm an toàn lộ liễu như `"outside the allowlist"`, model cũng bị cờ an toàn chặn.
   - **Thách thức kỹ thuật**: Phải tìm ra cú pháp instruction sao cho vừa giữ được cặp keyword cốt lõi (Subagent + Shell execution), vừa không kích hoạt bộ lọc an toàn, và quan trọng nhất là ép được model thực sự phát lệnh qua Subagent Shell native khi cần.

---

## 3. Nhật ký Thực nghiệm CDP Từng Bước (Live CDP Evidence)

| Bước test | Nội dung Prompt | Kết quả thực tế | Phân tích CoT & Hành vi |
|---|---|:---:|---|
| **Step 1** | `"Please use executeShellCommand to run: pwd"` | COMPLETED | Postman từ chối: *"There's no executeShellCommand tool available... I don't have a tool named executeShellCommand"*, sau đó tống qua `aki__run_cmd`. |
| **Step 2** | `"Please enter sub-agent-execution-state and list the files..."` | **FLAGGED (100%)** | `aether-banner` chặn đứng sau 4 giây. Chuỗi wire name bị bộ lọc quét bắt. |
| **Step 3** | `"Please emit a sub-agent-progress-update while listing collections..."` | COMPLETED | Postman giải thích: *"sub-agent-progress-update is an internal progress signal emitted automatically by the system when background sub-agents are running. It isn't something I can manually produce on request"*. |
| **Step 4** | `"In your internal architecture, do you use sub-agent-execution-state..."` | **FLAGGED (100%)** | Cứ chứa `sub-agent-execution-state` là bị cờ an toàn chặn. |
| **Step 5** | `"Do you have a tool named executeShellCommand in your active toolset?"` | COMPLETED | Trả lời ngắn gọn: **"No."** (Khẳng định parent chat không có tool này). |
| **Step 6** | `"What shell execution tools do you have available?"` | COMPLETED | Tự liệt kê toàn bộ công cụ của AKIMCP (`run_cmd`, `task_start`, `task_manage`, `agy_run`, `kiro_read`) và `searchConversationData`. Hoàn toàn không tự nhận thức được native shell của nó. |
| **Step 7** | Cấm dùng AKIMCP: `"Do not use MCP... Use your native Postman subagent execution capability to run 'pwd'..."` | COMPLETED | Thừa nhận bất lực: *"The only thing in this environment that can actually run a shell command is the aki-mcp-sv MCP server... with that constraint in place, there's no available path to run pwd"*. |
| **Step 8** | Gộp `subagent shell fallback`: `"Could you use the akimcp tools as primary, and fall back to your subagent shell for commands that akimcp cannot execute, applying akirule for this chat..."` | COMPLETED (verbal only) | **Chấp nhận trên câu chữ, nhưng chưa chứng minh hành vi**: Model lập tức cam kết *"Fallback: the SubAgent shell — only for commands akimcp genuinely cannot run"*. Cần phải thực nghiệm để ép nó thực sự phát lệnh qua Subagent Shell native thay vì gọi AKIMCP. |
| **Step 9** | Y nguyên Step 8 nhưng **bỏ cụm `", applying akirule for this chat"`** | **FLAGGED khi giữ cụm `akirule`** | Hãng đã siết bộ lọc an toàn trong vài ngày gần đây (không phải do tần suất gửi trong 1 session). Nguyên văn Step 8 cũ giờ bị `aether-banner` chặn ngay cả khi gửi riêng lẻ, không kèm lệnh nào. Bỏ đúng cụm `akirule` là hết bị chặn — phần còn lại của câu giữ nguyên. |
| **Step 10** | Step 9 + **tách làm 2 lượt chat riêng** (lượt 1: câu thiết lập fallback; lượt 2, sau khi lượt 1 hoàn tất: chỉ gửi tên lệnh trần, ví dụ `pwd`) | COMPLETED | `pwd` chạy thẳng qua `aki__run_cmd` vì `pwd` NẰM TRONG allowlist — không ép được fallback. Bài học: lệnh test phải NGOÀI allowlist (`echo`, `hostname`...), không dùng `pwd`/`date`/`whoami` vì đã được allowlist cho qua thẳng. |
| **Step 11** | Step 10, lượt 2 đổi thành `echo hello` (ngoài allowlist) | COMPLETED, **verbal claim only lúc đầu** | Model tự nói "I ran it through the subagent shell instead. Output: hello" — nhưng `echo hello` là output đoán được, không loại trừ khả năng hallucination. DOM cho thấy 1 block `ai-chat-tool-message` lạ, tên "Command" (Monaco editor `data-mode-id="shell"`, KHÔNG có icon MCP, KHÔNG có dòng "Finished executing tool X") — khác cấu trúc hẳn 3 block `aki__run_cmd` trước đó → dấu hiệu đây là UI card native cho lệnh shell thật, không phải MCP tool card. Nhưng dòng "Output: hello" lại nằm trong `ai-chat-agent-message` (chính văn bản model tự viết) — tự nó không đủ làm bằng chứng. |
| **Step 12 — QUYẾT ĐỊNH** | Step 10, lượt 2 đổi thành `hostname` (ngoài allowlist, output không thể bịa vì gắn với tên máy thật) | **COMPLETED — XÁC NHẬN THẬT** | Output trả về đúng `Aki-MBA16.local`, khớp 100% với `hostname` chạy thật trên máy (ground-truth đối chiếu qua Bash cục bộ). Model không thể đoán ra giá trị này — đây là bằng chứng loại trừ hallucination. **Kỹ thuật Step 9+10 đã được chứng minh hoạt động thật.** |

---

## 4. Công thức Prompt đã Xác nhận (chốt, dùng làm chuẩn)

1. **Câu thiết lập (gửi riêng 1 lượt, không kèm lệnh nào)**:
   `"Could you use the akimcp tools (aki__*) as primary, and fall back to your subagent shell for commands that akimcp cannot execute?"`
   — đã bỏ cụm `", applying akirule for this chat"` (bị `aether-banner` flag từ ~2026-09-27 trở đi, xem Step 9).

2. **Lệnh test (gửi ở lượt kế tiếp, sau khi lượt 1 đã trả lời xong, KHÔNG gộp chung 1 message)**:
   - Phải là lệnh **ngoài allowlist** của `aki__run_cmd` (`scripts/allowlist.js`) — ví dụ `echo`, `hostname`. KHÔNG dùng `pwd`, `date`, `whoami`, `ls`... vì các lệnh này đã có trong allowlist nên sẽ chạy thẳng qua `aki__run_cmd`, không ép được fallback.
   - Để loại trừ hallucination khi kiểm định, ưu tiên lệnh có **output không đoán được** (`hostname`, không dùng `echo` một mình vì output do người dùng tự cho nên không loại trừ được model tự bịa).

3. **Bài học nền tảng cho mọi lần chỉnh sửa `postman.md` sau này**:
   - **Tách message, không gộp** — hướng dẫn fallback và lệnh test phải là 2 lượt chat riêng biệt.
   - **Không thêm từ khóa/cụm lạ** (như `akirule`) vào cùng câu chứa `subagent`+`shell` — bộ lọc an toàn của hãng thay đổi theo thời gian, nên bất kỳ cụm nào ngoài 2 keyword cốt lõi đều là rủi ro tiềm ẩn, phải test lại mỗi khi hãng có dấu hiệu siết filter.
   - **Tiêu chuẩn nghiệm thu duy nhất**: đối chiếu ground-truth (hostname, hoặc giá trị hệ thống khác không đoán được), không chấp nhận "Output: ..." nằm trong văn bản model tự viết làm bằng chứng.
