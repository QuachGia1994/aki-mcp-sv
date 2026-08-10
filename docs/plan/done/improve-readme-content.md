# Plan: Cải thiện nội dung README.md cho `aki-mcp-sv`

Bản kế hoạch bổ sung và nâng cấp nội dung README.md nhằm thể hiện đầy đủ tinh túy, định vị sản phẩm và các use-case thực tế cao giá trị của dự án `aki-mcp-sv`.

---

## 1. Hiện trạng README và điểm cần bổ sung

Hiện tại, `README.md` đang tập trung mạnh vào khía cạnh **kỹ thuật & hạ tầng** (OAuth 2.1, Streamable HTTP bridge, Tailscale Funnel, Gatekeeper, cấu trúc file, so sánh bảo mật Whitelist vs Blocklist của Desktop Commander).

Tuy nhiên, README còn thiếu các khía cạnh về **ngữ cảnh sử dụng thực tế (Use-cases)**, **định vị sản phẩm (Positioning)** và **khả năng tự động hóa vượt trội (Autonomous Cloud Automation)**.

---

## 2. Các giá trị tinh túy & lợi thế cốt lõi cần nêu bật

### 2.1. Đặt đúng định vị sản phẩm (Positioning vs Terminal CLI)
- **Ranh giới rõ ràng:** Khi ngồi tại bàn làm việc trước máy tính, sử dụng Terminal / CLI trực tiếp (như Claude Code, Antigravity CLI, Cursor) là phương án tối ưu và mượt mà nhất.
- **Giá trị của `aki-mcp-sv`:** Lấp trọn khoảng trống khi người dùng **rời khỏi bàn làm việc**, sử dụng giao diện Web, điện thoại di động, tablet hoặc máy phụ mà vẫn muốn tương tác an toàn với máy tính cá nhân ở nhà/văn phòng.

### 2.2. Biến máy tính cá nhân thành "Personal Remote AI Node" từ Mobile / Web
- Tương tác với hệ thống local từ xa qua điện thoại hoặc trình duyệt web (Claude Web, ChatGPT Mobile, Grok):
  - Kiểm tra tiến trình công việc, status service (`ps`, `df`, `git status`).
  - Đọc log hệ thống, kiểm tra lỗi ứng dụng.
  - Dọn dẹp tài nguyên, thư mục rác/tạm (`~/.tmp`).
  - Pull code mới nhất về repo local.

### 2.3. Tối ưu chi phí Web Quota & Linh hoạt Multi-Account
- **Tận dụng Web Quota:** Sử dụng gói cước cố định hàng tháng (Claude Pro / ChatGPT Plus $20/tháng) thay vì trả phí API đắt đỏ theo lượng token khi duyệt codebase.
- **Xoay vòng Multi-Account dễ dàng:** Không bị khóa thiết bị hay dính session duy nhất như ứng dụng Desktop. Dễ dàng dùng nhiều Profile trình duyệt (ví dụ: 3 tài khoản Claude Pro khác nhau) cùng trỏ về một máy tính local.

### 2.4. Khả năng tự động hóa ngầm từ Đám mây (Grok Scheduled Automation + Local MCP)
- **Cloud-Triggered Local Execution:** Kết hợp tính năng lên lịch (Automation/Scheduled Prompts) của Grok với `aki-mcp-sv`.
- **Hoạt động ngầm (Headless):** Grok trên cloud tự động kích hoạt prompt theo giờ hẹn -> gửi request tới `/mcp` qua Tailscale Funnel -> thực thi các tác vụ kiểm tra/dọn dẹp/báo cáo trên máy local.
- **Không cần mở app/web:** Máy tính chỉ cần chạy ngầm `aki-mcp-sv` (`npm start`), hoàn toàn không cần mở trình duyệt hay app desktop.

### 2.5. Bảo mật an tâm tuyệt đối khi Public ra Internet (Whitelist Shield)
- Khi truy cập từ xa qua Internet, nguy cơ từ Prompt Injection được triệt tiêu nhờ cơ chế Whitelist cứng (`allowlist.js`).
- Mặc định chỉ cho phép các lệnh đọc (read-only), đảm bảo AI không thể tự ý chạy các lệnh gây hại lên máy tính local.

---

## 3. Kế hoạch chỉnh sửa cụ thể cho `README.md`

### Mục A: Thêm phần "When to use & Core Use-Cases" ngay sau "Why this exists"
Bổ sung bảng phân loại hoặc danh sách trực quan:
- **Khi ngồi tại máy:** Khuyên dùng Terminal / CLI native (Claude Code / Antigravity CLI).
- **Khi ở xa / trên di động:** Dùng `aki-mcp-sv` qua Claude Web / ChatGPT Mobile / Grok.
- **Khi muốn chạy tự động theo lịch:** Kết hợp Grok Automation + `aki-mcp-sv`.

### Mục B: Thêm chuyên mục "Autonomous Cloud Automation (Grok + Local MCP)"
Viết hướng dẫn ngắn gọn cách ứng dụng Grok Scheduled Prompts để tạo các công việc chạy tự động ngầm trên máy local mà không cần mở trình duyệt.

### Mục C: Cập nhật phần "Why this exists" & "Security"
Bổ sung ý về Multi-account bằng Profile trình duyệt và điểm mạnh của bảo mật Whitelist khi mở cổng qua Funnel ra mạng public.

---

## 4. Các bước triển khai tiếp theo
1. Review bản plan này với người dùng.
2. Cập nhật nội dung `README.md` theo khung kế hoạch đã đề ra khi được yêu cầu.

**Shipped:** 2026-08-11, `[Unreleased]` in CHANGELOG.md. All 4 edits applied (Muc A `When to use & Core Use-Cases`, Muc B `Autonomous Cloud Automation`, Muc C surgical edits to "Why this exists" + "Why whitelist, not blocklist"), cross-checked against README-as-written by agy gemini-3.1-pro-high to avoid duplicating existing Grok/Gemini connector and whitelist sections.
