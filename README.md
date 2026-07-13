# Hue Forest Manager

Webapp quản lý rừng cho Chi cục Kiểm lâm thành phố Huế, sử dụng OpenStreetMap/Leaflet.

## Chức năng

- Đăng ký, đăng nhập và quy trình admin duyệt/từ chối tài khoản.
- Phân quyền `admin`, `mod`, `user`.
- Admin quản lý người dùng, vai trò, nhóm và gán thành viên vào nhóm.
- Mod xem waypoint/tracklog của nhóm và chỉnh sửa thông tin thành viên trong nhóm.
- User chỉ xem, tạo và xóa waypoint/tracklog của chính mình.
- Định vị nhanh bằng Geolocation API của trình duyệt.
- Ghi tracklog GPS trực tiếp; tính chiều dài; xuất dữ liệu GeoJSON.
- PostgreSQL trên Render, SQLite khi chạy local.

## Chạy local

```bash
cp .env.example .env
npm install
npm start
```

Mở `http://localhost:3000`. Tài khoản admin mặc định lấy từ `.env`. Nếu không cấu hình:

- Email: `admin@kiemlamhue.gov.vn`
- Mật khẩu: `ChangeMe123!`

Hãy đổi mật khẩu này bằng biến môi trường trước khi đưa hệ thống vào sử dụng.

## Triển khai Render bằng Blueprint

1. Giải nén, đưa toàn bộ thư mục lên một GitHub repository.
2. Trong Render chọn **New > Blueprint**.
3. Kết nối repository; Render đọc file `render.yaml` và tạo Web Service + PostgreSQL.
4. Khi được hỏi, nhập biến bí mật `ADMIN_PASSWORD`.
5. Sau khi deploy, truy cập URL HTTPS của Render.

Geolocation trên điện thoại yêu cầu HTTPS; Render cung cấp HTTPS mặc định.

## Biến môi trường quan trọng

- `SESSION_SECRET`: chuỗi bí mật dài và ngẫu nhiên.
- `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD`: tài khoản admin khởi tạo.
- `DATABASE_URL`: Render tự gắn từ PostgreSQL.

## Lưu ý vận hành

Đây là bản MVP sẵn sàng triển khai. Trước khi dùng cho dữ liệu nghiệp vụ nhạy cảm, nên bổ sung sao lưu định kỳ, nhật ký kiểm toán, xác thực hai lớp, chính sách mật khẩu, giới hạn đăng nhập, kiểm thử bảo mật và quy trình phân loại dữ liệu.
