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

## Lớp bản đồ tải lên

Trang **Bản đồ số** hỗ trợ tải các lớp:

- **GeoJSON / JSON**: hiển thị điểm, đường và vùng bằng Leaflet.
- **KML**: được chuyển đổi sang GeoJSON trên máy chủ trước khi lưu.
- **MBTiles**: hỗ trợ tile raster PNG/JPEG/WebP và vector tile PBF/MVT khi tệp có metadata phù hợp.

Lớp bản đồ được lưu trong PostgreSQL nên không phụ thuộc ổ đĩa tạm của Render. Phân quyền dữ liệu giống waypoint/tracklog: user xem lớp do mình tạo, mod xem lớp của nhóm, admin xem tất cả. Dung lượng mặc định tối đa là 50 MB/tệp; có thể thay đổi bằng biến môi trường `MAX_LAYER_FILE_MB`.

> Với các bộ MBTiles lớn, nên dùng PostgreSQL trả phí và tăng giới hạn upload có kiểm soát. Gói miễn phí có giới hạn tài nguyên và dung lượng cơ sở dữ liệu.

## Xuất tracklog kèm waypoint

Tại danh sách tracklog trên trang Bản đồ, mỗi track có ba lựa chọn xuất:

- **GeoJSON + WP**: dùng tốt với QGIS và các hệ GIS.
- **GPX + WP**: dùng với thiết bị/phần mềm GPS.
- **KML + WP**: dùng với Google Earth và nhiều phần mềm bản đồ.

Tệp xuất chứa tracklog được chọn cùng toàn bộ waypoint mà tài khoản hiện tại có quyền xem. Nhờ vậy có thể chồng lớp, đối chiếu vị trí waypoint với tuyến tuần tra và so sánh giữa các lần khảo sát.

## Cảnh báo cháy rừng thành phố Huế

Ứng dụng lấy danh sách phường/xã thành phố Huế (mã tỉnh 46) từ API công khai `34tinhthanh.com` và cung cấp bộ lọc địa bàn trong mục **Cảnh báo cháy rừng**.

Hệ thống `v2.pcccr.vn` chưa công bố tài liệu API công khai trong quá trình phát triển. Vì vậy ứng dụng hỗ trợ:

1. Nút mở trực tiếp bản đồ điểm cháy chính thức tại `https://v2.pcccr.vn/diem-chay`.
2. Bộ kết nối API cấu hình qua biến môi trường `PCCCR_API_URL` và `PCCCR_API_TOKEN`. Endpoint có thể trả GeoJSON FeatureCollection hoặc mảng JSON chứa `latitude/longitude` (hoặc `lat/lng`). Máy chủ sẽ chuẩn hóa thành GeoJSON và hiển thị trên Leaflet.
3. Tự động gửi `province_code=46`; khi chọn phường/xã, gửi thêm `ward_code`.

Trên Render, vào **Environment** để khai báo endpoint/token do đơn vị vận hành PCCCR cấp. Không đưa token vào GitHub.
