# 📘 Hướng Dẫn Chạy Dự Án Notion Workers

---

## ⚡ Mỗi lần mở máy — chỉ cần 3 bước

```powershell
# 1. Mở WSL (trên PowerShell)
wsl
```

```bash
# 2. Vào thư mục dự án
cd /home/khanh/theo-doi-doi-thu

# 3. Deploy hoặc chạy thử
ntn workers deploy
# hoặc chạy thử local:
ntn workers exec sayHello --local -d '{"name": "Khanh"}'
```

> Xong! Không cần làm gì thêm nếu bạn đã cài đặt lần đầu rồi.

---

## 🔧 Cài đặt lần đầu (chỉ làm 1 lần duy nhất)

> Nếu bạn đã từng chạy được dự án này rồi, **bỏ qua phần này**.

### Yêu cầu trước khi bắt đầu

- Windows 10/11 đã cài **WSL 2** (Windows Subsystem for Linux)
- Đã cài **Ubuntu** (hoặc distro Linux khác) trong WSL
- Có tài khoản **Notion**

---

## Bước 1 — Mở WSL trên PowerShell

Mở **PowerShell** (hoặc **Windows Terminal**) và gõ:

```powershell
wsl
```

> Lệnh này sẽ mở terminal Linux (Ubuntu). Tất cả các bước tiếp theo đều chạy bên trong WSL.

---

## Bước 2 — Cài Node.js >= 22

Kiểm tra phiên bản Node hiện tại:

```bash
node --version
```

Nếu chưa có hoặc phiên bản < 22, cài bằng `nvm`:

```bash
# Cài nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# Tải lại shell để nvm hoạt động
source ~/.bashrc

# Cài Node.js 22
nvm install 22
nvm use 22
```

---

## Bước 3 — Cài CLI `ntn` của Notion

```bash
curl -fsSL https://ntn.dev | bash
```

Sau khi cài xong, kiểm tra:

```bash
ntn --version
```

---

## Bước 4 — Đi vào thư mục dự án

```bash
cd /home/khanh/theo-doi-doi-thu
```

> Nếu bạn clone dự án về vị trí khác, thay đường dẫn tương ứng.

---

## Bước 5 — Cài dependencies

```bash
npm install
```

---

## Bước 6 — Cấu hình biến môi trường

File `.env` đã có sẵn trong dự án. Mở để kiểm tra:

```bash
cat .env
```

Nếu cần thêm biến (ví dụ: `NOTION_API_TOKEN`), chỉnh sửa bằng:

```bash
nano .env
```

Thêm dòng:
```
NOTION_API_TOKEN=secret_xxx...
```

> Lấy token tại: https://app.notion.com/developers/connections

---

## Bước 7 — Đăng nhập Notion

```bash
ntn login
```

Lệnh này sẽ mở trình duyệt để bạn xác thực tài khoản Notion.

---

## Bước 8 — Build & kiểm tra TypeScript

```bash
npm run check
```

Nếu không có lỗi, tiến hành build:

```bash
npm run build
```

---

## Bước 9 — Deploy worker lên Notion

```bash
ntn workers deploy
```

Lệnh này sẽ build và publish tất cả các capabilities (tools, syncs, webhooks) lên Notion.

---

## Bước 10 — Chạy thử tool cục bộ

```bash
ntn workers exec sayHello --local -d '{"name": "Khanh"}'
```

Kết quả mong đợi:
```
Hello, Khanh!
```

---

## 🔧 Các lệnh thường dùng

| Mục đích | Lệnh |
|---|---|
| Type-check TypeScript | `npm run check` |
| Build project | `npm run build` |
| Deploy lên Notion | `ntn workers deploy` |
| Chạy tool cục bộ | `ntn workers exec <tênTool> --local -d '{"key":"value"}'` |
| Xem danh sách capabilities | `ntn workers capabilities list` |
| Xem trạng thái sync | `ntn workers sync status` |
| Kích hoạt sync ngay lập tức | `ntn workers sync trigger <key>` |
| Preview sync (không ghi DB) | `ntn workers sync trigger <key> --preview` |
| Reset trạng thái sync | `ntn workers sync state reset <key>` |
| Xem log chạy gần nhất | `ntn workers runs list` |
| Xem log theo runId | `ntn workers runs logs <runId>` |
| Đặt biến môi trường remote | `ntn workers env set KEY=value` |
| Kéo biến môi trường về .env | `ntn workers env pull` |
| Xem URL webhook | `ntn workers webhooks list` |

---

## ❗ Lưu ý

- **Đừng commit file `.env`** lên git — nó đã được thêm vào `.gitignore`.
- Sau khi `ntn workers deploy`, sync **không reset** cursor. Nếu cần chạy lại từ đầu:
  ```bash
  ntn workers sync state reset <key>
  ntn workers sync trigger <key>
  ```
- Nếu deploy lần đầu và cần `NOTION_API_TOKEN`, tạo integration tại:  
  https://app.notion.com/developers/connections  
  rồi cấp quyền cho các trang/database cần thiết.

---

## 📞 Hỗ trợ thêm

- Tài liệu chính thức: https://developers.notion.com/workers/get-started/overview
- Notion Dev Slack: https://join.slack.com/t/notiondevs/shared_invite/zt-3u9oid9q8-HLUBmMVWYK~g9HFo4U4raA
