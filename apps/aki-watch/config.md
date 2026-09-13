# Aki Watch - hướng dẫn cấu hình Windows

Tài liệu này dùng chung cho bản cài `.exe`, `.msi` và bản portable. Cả ba bản đều dùng cùng một cấu hình theo tài khoản Windows; file cấu hình không nằm trong thư mục cài đặt và không nằm cạnh `aki-watch.exe`.

## 1. Vị trí cấu hình

Trên Windows, Aki Watch đọc và ghi:

```text
C:\Users\<TEN_USER>\.aki\mcpsv\postman-pool.json
```

Ví dụ với user Windows tên `YOUR_USER`:

```text
C:\Users\YOUR_USER\.aki\mcpsv\postman-pool.json
```

Thư mục `C:\Users\<TEN_USER>\.aki\mcpsv\` được tạo tự động khi runtime khởi tạo. Không chép file config có secret vào thư mục portable để chia sẻ cho người khác.

## 2. Yêu cầu trên máy Windows

- Node.js phải có trong `PATH`.
- Python 3 phải chạy được bằng `py -3`.
- Python phải có `telethon` và `selenium`.
- LibreWolf phải được cài đặt.
- Mỗi LibreWolf profile muốn dùng phải đăng nhập sẵn vào đúng tài khoản Postman.
- Nếu dùng Telegram Auto Watch, cần Telegram API ID/API Hash cho user-session và một bot để gửi báo cáo.

Cài package Python nếu máy mới chưa có:

```text
py -3 -m pip install telethon selenium
```

## 3. Cách cấu hình nhanh nhất

Mở Aki Watch -> `Settings`, điền các trường, chọn `Save Settings`, sau đó chạy `Environment Check`.

Aki Watch lưu cấu hình vào `~/.aki/mcpsv/postman-pool.json`. `Verify Login` kiểm tra trạng thái đăng nhập Postman theo từng LibreWolf profile. `Join Now` dùng cấu hình browser/profile hiện tại. `Auto Watch` lắng nghe một Telegram group và chỉ nhận invite từ đúng group + đúng sender nằm trong allowlist.

## 4. Mẫu `postman-pool.json`

Không copy nguyên các giá trị mẫu; thay placeholder bằng thông tin của máy/tài khoản của bạn.

```json
{
  "enabled": true,
  "telegramApiId": 12345678,
  "telegramApiHash": "YOUR_TELEGRAM_API_HASH",
  "telegramSessionPath": "C:\\Users\\YOUR_USER\\.aki\\mcpsv\\telegram-user.session",
  "sourceChatId": "-1001234567890",
  "adminUserIds": [123456789],
  "reportBotToken": "123456789:YOUR_BOT_TOKEN",
  "reportChatId": "123456789",
  "librewolfBinary": "C:\\Program Files\\LibreWolf\\librewolf.exe",
  "profilesRoot": "C:\\Users\\YOUR_USER\\AppData\\Roaming\\librewolf\\Profiles",
  "profileDirectories": [],
  "headless": true,
  "scratchRoot": "D:\\AkiTemp\\postman-pool",
  "timeoutSeconds": 45
}
```

JSON không hỗ trợ comment. Nếu tự sửa trực tiếp JSON, dấu `\` trong đường dẫn Windows phải viết thành `\\`.

## 5. Ý nghĩa từng field

| Field | Bắt buộc | Giá trị khuyến nghị | Ý nghĩa |
|---|---|---|---|
| `enabled` | Khuyến nghị | `true` | Cho phép watcher dùng cấu hình. GUI vẫn điều khiển Start/Stop riêng, nhưng `true` là trạng thái cấu hình bình thường. |
| `telegramApiId` | Có cho Auto Watch | Số nguyên dương | Telegram API ID của user-client, lấy tại `my.telegram.org/apps`. |
| `telegramApiHash` | Có cho Auto Watch | Chuỗi secret | Telegram API Hash đi cùng `telegramApiId`. Không chia sẻ. |
| `telegramSessionPath` | Có cho Auto Watch | `C:\Users\<user>\.aki\mcpsv\telegram-user.session` | Nơi Telethon lưu user session sau lần login đầu. File này nhạy cảm như credential đăng nhập. |
| `sourceChatId` | Có cho Auto Watch | Thường có dạng `-100...` | Telegram group duy nhất mà watcher được phép nhận invite. |
| `adminUserIds` | Có cho Auto Watch | Mảng numeric ID | Chỉ message từ sender ID trong danh sách này mới được xử lý. |
| `reportBotToken` | Có để gửi report | Bot token hoặc để trống nếu dùng env | Token của bot gửi báo cáo. Có thể không lưu trong JSON và dùng biến môi trường. |
| `reportChatId` | Có để gửi report | User ID/chat ID dạng chuỗi | Chat nhận báo cáo. Nếu gửi DM cho chính mình, phải bấm Start trên bot trước. |
| `librewolfBinary` | Thường cần | `C:\Program Files\LibreWolf\librewolf.exe` | Đường dẫn LibreWolf executable. |
| `profilesRoot` | Không nếu auto-detect được | `%APPDATA%\librewolf\Profiles` | Thư mục chứa các LibreWolf profile. Để trống để auto-detect. |
| `profileDirectories` | Không | `[]` để scan tất cả | Danh sách profile cần xử lý. Có thể dùng tên folder thật hoặc tên hiển thị mà scanner nhận ra. |
| `headless` | Không | `true` | Chạy join browser ẩn. `Verify Login` luôn được controller ép chạy headless. |
| `scratchRoot` | Không | Một thư mục tạm trên SSD còn trống | Nơi tạo bản copy tạm của LibreWolf profile cho automation. |
| `timeoutSeconds` | Không | `45` | Timeout của browser flow. Runtime giới hạn trong khoảng 10-120 giây. |

## 6. Lấy Telegram API ID và API Hash

1. Đăng nhập `https://my.telegram.org/` bằng tài khoản Telegram cá nhân đang ở trong group cần theo dõi.
2. Mở `API development tools` và tạo app.
3. Copy `api_id` vào `telegramApiId`.
4. Copy `api_hash` vào `telegramApiHash`.
5. Không đưa `telegramApiHash` vào Git, screenshot công khai, file ZIP phát hành hoặc chat group.

Có thể giữ hai giá trị này ngoài JSON bằng biến môi trường:

```text
AKI_POSTMAN_POOL_TELEGRAM_API_ID
AKI_POSTMAN_POOL_TELEGRAM_API_HASH
```

Biến môi trường sẽ override giá trị trong JSON khi watcher load config.

## 7. Tạo Telegram user session lần đầu

Nếu chạy từ source repo:

```text
py -3 scripts/postman-pool-telegram.py --login --config C:\Users\YOUR_USER\.aki\mcpsv\postman-pool.json
```

Trong bản cài hoặc portable, dùng nút Telegram Login trong Aki Watch. Lần đầu Telegram có thể yêu cầu số điện thoại, login code và 2FA. Sau khi thành công, file ở `telegramSessionPath` được tạo và các lần sau không cần login lại nếu session còn hiệu lực.

`telegram-user.session` là credential đăng nhập. Không đưa file này vào ZIP phát hành.

## 8. Lấy `sourceChatId` và `adminUserIds`

Sau khi có Telethon session, dùng chức năng Telegram trong Aki Watch để xem các group và chọn đúng group nguồn. `sourceChatId` phải là ID của group Postman Pool cần theo dõi.

Để lấy sender ID của admin, dùng nút Observe Sender trong Aki Watch hoặc từ source repo chạy:

```text
py -3 scripts/postman-pool-telegram.py --observe-senders --config C:\Users\YOUR_USER\.aki\mcpsv\postman-pool.json
```

Chờ admin mục tiêu gửi một message trong group, lấy numeric sender ID rồi thêm vào `adminUserIds`. Có thể allowlist nhiều admin:

```json
"adminUserIds": [111111111, 222222222]
```

Watcher bỏ qua invite từ group khác hoặc sender không nằm trong danh sách này.

## 9. Cấu hình bot gửi báo cáo

Tạo hoặc dùng lại bot từ `@BotFather`, sau đó lấy token và điền `reportBotToken`.

Để không lưu bot token trong JSON, để `reportBotToken` trống và đặt biến môi trường:

```text
AKI_POSTMAN_POOL_REPORT_BOT_TOKEN
```

Biến môi trường có ưu tiên cao hơn token trong config.

`reportChatId` là chat nhận báo cáo. Nếu dùng DM với tài khoản của mình, mở bot và bấm `Start` trước; sau đó dùng Telegram user ID của mình làm `reportChatId`.

Aki Watch gửi một report sau mỗi `Join Now`, kể cả khi một số account fail. Token không được in lại trong GUI/log; lỗi report được redaction token trước khi hiển thị.

## 10. Cấu hình LibreWolf và Postman profiles

Đường dẫn phổ biến trên Windows:

```text
C:\Program Files\LibreWolf\librewolf.exe
C:\Users\YOUR_USER\AppData\Roaming\librewolf\Profiles
```

Mỗi profile phải đăng nhập Postman sẵn. Automation tạo bản copy tạm của profile thay vì điều khiển trực tiếp profile gốc, vì vậy LibreWolf gốc có thể đang mở mà không bị sửa profile.

Nếu `profileDirectories` là `[]`, Aki Watch discover tất cả profile hợp lệ trong `profilesRoot`. Nếu chỉ muốn dùng một số profile:

```json
"profileDirectories": [
  "Hồ sơ 1",
  "Hồ sơ 2",
  "default-default"
]
```

Tên có thể là tên hiển thị hoặc tên thư mục profile mà scanner nhận diện được.

## 11. `headless`, `scratchRoot`, `timeoutSeconds`

`headless: true` phù hợp khi muốn Join chạy ẩn, không mở hàng loạt browser window. Nếu cần debug giao diện Postman có thể tạm đặt `false`; tùy chọn này không dùng để vượt CAPTCHA/Cloudflare challenge.

`scratchRoot` chứa profile clone tạm. Nên đặt trên SSD có đủ dung lượng và quyền ghi. Không trỏ nó vào chính `profilesRoot`.

`timeoutSeconds` mặc định 45. Runtime clamp 10-120. Tăng timeout khi mạng/website chậm; tăng timeout không biến security challenge thành flow có thể tự động bypass.

## 12. Kiểm tra cấu hình

Nếu chạy từ source repo:

```text
node scripts/postman-pool-setup.js --check
```

Xem cấu hình ở dạng đã che secret:

```text
node scripts/postman-pool-setup.js --get-config-json
```

Kiểm tra browser/profile discovery:

```text
py -3 scripts/postman-pool-join.py --dry-run
```

Kiểm tra LibreWolf có khởi động được với profile copy:

```text
py -3 scripts/postman-pool-join.py --smoke-browser
```

Kiểm tra Postman login của các profile:

```text
py -3 scripts/postman-pool-join.py --verify-login
```

Trong bản cài hoặc portable, dùng `Environment Check`, `Scan Profiles` và `Verify Login` trong GUI thay cho các lệnh source-repo trên.

## 13. Khác nhau giữa EXE, MSI và portable

### Setup EXE

Chạy `Aki Watch_0.1.0_x64-setup.exe` và cài theo wizard. Config vẫn nằm ở `C:\Users\<user>\.aki\mcpsv\postman-pool.json`.

### MSI

Chạy `Aki Watch_0.1.0_x64_en-US.msi`. MSI phù hợp với Windows Installer/triển khai quản trị. Config vẫn là config per-user ở `~\.aki\mcpsv`, không nằm trong MSI.

### Portable

Giải nén toàn bộ ZIP ra một folder bình thường rồi mới chạy `aki-watch.exe`. Không chạy EXE trực tiếp bên trong ZIP. Phải giữ `aki-watch.exe` và `aki-watch-runtime\` cạnh nhau. `config.md` và `README.txt` có thể nằm cạnh EXE để tham khảo; file config thật vẫn ở `C:\Users\<user>\.aki\mcpsv\postman-pool.json`.

## 14. Chuyển sang máy Windows khác

1. Cài Node.js, Python 3, `telethon`, `selenium` và LibreWolf.
2. Giải nén portable hoặc cài EXE/MSI.
3. Đăng nhập Postman trên các LibreWolf profile của máy mới.
4. Mở Aki Watch -> Settings và tạo config cho máy mới.
5. Telegram user session nên login lại trên máy mới. Nếu chủ động copy file `.session`, coi nó là secret đăng nhập và bảo vệ như credential.
6. Chạy `Environment Check` -> `Scan Profiles` -> `Verify Login`.
7. Gửi Test Report cho Telegram bot.
8. Chỉ sau khi các check cần thiết pass mới bật `Auto Watch` hoặc chạy `Join Now`.

Không đóng gói sẵn `postman-pool.json`, bot token, API hash hoặc `.session` vào bộ cài phát hành.

## 15. Lỗi thường gặp

| Lỗi | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `Config not found` | Chưa Save Settings | Mở Settings, điền và Save một lần. |
| `telegramApiId/telegramApiHash/sourceChatId/adminUserIds is incomplete` | Thiếu thông tin watcher | Điền đủ Telegram credentials, group nguồn và allowlist admin. |
| `reportBotToken/reportChatId is incomplete` | Chưa cấu hình report | Điền bot token/chat ID hoặc đặt env bot token. |
| `LibreWolf profiles root not found` | `profilesRoot` sai | Dùng `%APPDATA%\librewolf\Profiles` hoặc để trống để auto-detect. |
| `LibreWolf profile not found` | `profileDirectories` có tên không tồn tại | Scan lại profiles và chọn đúng tên scanner trả về. |
| `No signed-in Postman account card` | Profile không còn login Postman | Mở đúng LibreWolf profile, login Postman lại rồi chạy Verify Login. |
| `Just a moment...` / `cloudflare_challenge` | Postman/Cloudflare security challenge | Aki Watch không bypass challenge; hoàn tất đăng nhập/challenge hợp lệ trên profile rồi retry. |
| `500 - Server Error` ở Postman | Lỗi phía Postman hoặc transient flow | Retry sau khi xác nhận profile vẫn signed in; nếu lặp lại, xem Realtime log. |
| Telegram report fail | Bot chưa Start, chat ID sai, token sai hoặc mạng lỗi | Dùng Test Report trong Settings và kiểm tra bot/chat ID. |
| Portable mở được nhưng backend action fail | `aki-watch.exe` bị tách khỏi `aki-watch-runtime` | Giải nén lại nguyên package, giữ hai thành phần cạnh nhau. |

## 16. Biến môi trường hỗ trợ

| Biến | Tác dụng |
|---|---|
| `AKI_POSTMAN_POOL_TELEGRAM_API_ID` | Override `telegramApiId` trong JSON. |
| `AKI_POSTMAN_POOL_TELEGRAM_API_HASH` | Override `telegramApiHash` trong JSON. |
| `AKI_POSTMAN_POOL_REPORT_BOT_TOKEN` | Override `reportBotToken` trong JSON. |
| `AKI_WATCH_REPO_DIR` | Chỉ dành cho dev/debug: ép packaged app dùng một checkout repo hợp lệ thay cho runtime scripts bundled. Máy người dùng bình thường không cần biến này. |

## 17. Nguyên tắc bảo mật

- Không commit `postman-pool.json` có secret vào Git.
- Không chia sẻ `telegramApiHash`, `reportBotToken` hoặc file Telethon `.session`.
- Không log/paste Postman invite URL công khai.
- Chỉ allowlist đúng Telegram group và đúng admin sender cần theo dõi.
- Aki Watch tự động hóa flow Postman bình thường; nó không giải CAPTCHA và không bypass persistent security challenge.
