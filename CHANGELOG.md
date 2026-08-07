# Changelog

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/), phiên bản theo [SemVer](https://semver.org/lang/vi/).

## [0.2.0] — 2026-08-07

Bản đầu tiên dùng được cho người ngoài: bỏ mọi thứ chỉ đúng trên máy tác giả.

### Added
- `scripts/userdata.js` — mọi dữ liệu người dùng (config đang chạy, OAuth client, passphrase, token) gom về `~/.aki/mcpsv/`, secrets mode 0600. Bản cài cũ ghi trong `<repo>/data/` được copy sang lần chạy đầu.
- `scripts/tailscale.js` — đọc trạng thái Funnel một chỗ, dùng chung `start.js` và panel.
- `scripts/allowlist.js` — bộ lệnh shell mặc định thành nguồn duy nhất: server enforce và panel hiển thị cùng một bộ.
- `scripts/search-mcp.js` — `find_path` / `search_content`, quét cả cây trong một lần gọi.
- `scripts/chrome.js` — điều khiển Chrome qua CDP, không phụ thuộc package ngoài.
- Panel: mục Tailscale kèm đèn trạng thái, nút chọn thư mục bằng hộp thoại macOS (chọn nhiều cái một lần), mục akidevrule kèm lệnh cài hiện rõ, footer hệ sinh thái AkiTao.
- Panel hiển thị nguyên văn mọi lệnh cần copy: lệnh cài akidevrule, lệnh mở rộng khung chat claude.ai.

### Changed
- Thư mục gốc mặc định của filesystem MCP: `$HOME` thay cho đường dẫn cứng của tác giả.
- `mcp-hub.config.json` trong repo trở thành bản mặc định được ship; bản chạy thật nằm ở `~/.aki/mcpsv/` nên sửa gì trong panel cũng không đẻ ra diff.
- Panel sắp lại theo đúng thứ tự cần làm, Chrome xuống cuối vì là tuỳ chọn.
- Chrome: "Kết nối" không bao giờ tự thoát Chrome nữa — Chrome chỉ mở cổng debug lúc khởi động, nên việc mở lại nằm sau một nút nói rõ nó sẽ làm gì.

### Fixed
- Funnel bị bật lại mỗi lần `npm start`: `AllowFunnel` khoá theo cổng công khai (443) chứ không theo cổng nội bộ, nên phép so cổng 9999 không bao giờ khớp. Bật lại liên tục có thể dính rate limit chứng chỉ của Let's Encrypt.
- Panel không kiểm tra dữ liệu gửi lên: allowlist sai kiểu làm `Array.isArray` thành false và **âm thầm mở mọi subcommand** của lệnh đó. Nay chặn ngay ở biên kèm thông báo sửa được.
- Panel hiển thị allowlist rỗng rồi lưu đè lên toàn bộ bộ mặc định.
- Nút "Copy cả 5 giá trị" quét nhầm mọi ô copy trên trang.

## [0.1.0]

- MCP server (filesystem + shell) expose qua Tailscale Funnel với gatekeeper OAuth 2.1.
