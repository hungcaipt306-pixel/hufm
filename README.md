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

## PWA và làm việc offline

- Cài webapp lên màn hình chính từ trình duyệt để chạy dạng PWA.
- Trang bản đồ, CSS, JavaScript và dữ liệu bản đồ gần nhất được lưu trên thiết bị.
- Waypoint/tracklog tạo khi mất mạng được lưu trong IndexedDB.
- Khi có Internet, ứng dụng tự gọi `/api/sync`; mã `clientId` chống tạo bản ghi trùng khi gửi lại.
- Nút **Tải vùng đang xem** lưu tile theo khung bản đồ và dải zoom đã chọn. Giới hạn bằng `OFFLINE_TILE_MAX`.
- Không dùng `tile.openstreetmap.org` để tải hàng loạt. Khi triển khai chính thức, nên đặt `OFFLINE_TILE_URL` thành tile server tự quản lý hoặc nhà cung cấp cấp quyền offline/prefetch.
- Trên iPhone/iPad, PWA và dữ liệu offline phụ thuộc dung lượng lưu trữ của Safari; cán bộ nên mở ứng dụng và tải vùng trước khi đi rừng.

## Định vị realtime và nút tải nhanh

- Nút **Dữ liệu** và **Lớp bản đồ** nổi ở góc bản đồ để tải lại dữ liệu máy chủ mà không rời trang.
- Sau khi bấm **Định vị**, ứng dụng dùng `watchPosition` để cập nhật vị trí liên tục.
- Mũi tên vị trí xoay theo hướng GPS (`coords.heading`); khi đứng yên, ứng dụng dùng cảm biến la bàn của thiết bị nếu trình duyệt cho phép.
- Vòng tròn quanh marker thể hiện độ chính xác GPS hiện tại.
- Định vị realtime vẫn tiếp tục sau khi dừng ghi tracklog, giúp cán bộ theo dõi vị trí hiện tại trên bản đồ.
- Trên iPhone, lần đầu bật định vị có thể xuất hiện yêu cầu cấp quyền truy cập chuyển động và hướng.


## Giao diện map-first và định vị hướng lên
- Bản đồ luôn chiếm vùng làm việc chính; panel công cụ có thanh cuộn độc lập.
- Các nút Định vị, Hướng lên, Waypoint, Ghi tuyến và Dừng nằm nổi trực tiếp trên bản đồ.
- Nút Hướng lên dùng cảm biến la bàn/GPS để xoay bản đồ theo hướng cầm điện thoại; người dùng có thể tắt để trở về hướng Bắc.
- Nút Cập nhật app yêu cầu Service Worker kiểm tra phiên bản mới, làm mới bộ nhớ đệm giao diện và tải lại HUFM.


## Trang mặc định

Sau khi đăng nhập hoặc mở ứng dụng, người dùng được đưa thẳng vào panel **Bản đồ**. Mục **Tổng quan** vẫn có trong menu.

## Khắc phục bản đồ/GPS phiên bản 1.0.1
- Leaflet và Leaflet.VectorGrid được cài bằng npm và phục vụ nội bộ, không còn phụ thuộc CDN unpkg.
- Bổ sung Permissions-Policy cho geolocation và cảm biến hướng.
- Service Worker cache v7 để thay thế tài nguyên cũ.
- Bổ sung thông báo chi tiết khi người dùng từ chối quyền GPS hoặc thiết bị chưa lấy được vị trí.


## Thời tiết và nguy cơ cháy rừng thông minh
- API mặc định: Open-Meteo, không cần API key.
- HUFM tính điểm nguy cơ 0-100 và 5 cấp từ nhiệt độ, độ ẩm, gió/gió giật, mưa dự báo và mưa 24 giờ gần nhất.
- Có dự báo 4 ngày và khuyến nghị nghiệp vụ theo cấp nguy cơ.
- Người dùng có thể tính theo trung tâm Huế hoặc vị trí GPS hiện tại.
- Đây là chỉ số hỗ trợ nghiệp vụ, không thay thế cấp dự báo cháy rừng chính thức.
- Có endpoint tùy chọn `/api/fire-hotspots` dùng NASA FIRMS khi cấu hình `FIRMS_MAP_KEY`.

## Cập nhật giao diện chọn lớp trên điện thoại

Bảng chọn lớp Leaflet được thu gọn thành nút nhỏ ở mép trái bản đồ. Chạm nút để mở danh sách lớp có thanh cuộn; chạm bản đồ để đóng. Các ô radio/checkbox được giới hạn kích thước để không che bản đồ trên iPhone.

## Cập nhật giao diện 1.0.2

- Panel Công cụ có vùng cuộn độc lập, quán tính cuộn trên iOS và thanh cuộn mảnh.
- Các nhóm chức năng dùng accordion gọn, hiệu ứng mở/đóng mượt hơn.
- Bản đồ tự tính lại kích thước bằng ResizeObserver và có lớp nền địa hình dự phòng khi OSM lỗi.
- Bỏ nút làm mới dữ liệu trùng lặp ở góc bản đồ.
- Nút Cập nhật dùng biểu tượng hai mũi tên, đồng bộ dữ liệu/lớp/thời tiết/cảnh báo, tải lại tile và hiển thị “Đã cập nhật lại”.
- Nâng cache PWA lên hue-shell-v10.


## Sửa lỗi font KML tiếng Việt 1.0.3

- Tự nhận dạng UTF-8, UTF-8 BOM, UTF-16 LE/BE, Windows-1258 và Windows-1252 theo BOM hoặc khai báo XML.
- Khôi phục chuỗi tiếng Việt bị mojibake như `Huáº¿`, `phÆ°á»ng`, `Ä‘á»‹a giá»›i`.
- Chuẩn hóa Unicode NFC cho tên lớp, tên đối tượng, mô tả và ExtendedData/SimpleData.
- Sửa tên tệp KML tiếng Việt bị sai khi Multer nhận tên file theo Latin-1.
- Các lớp KML cũ cũng được sửa khi trả dữ liệu ra bản đồ; không bắt buộc tải lại, dù tải lại vẫn được khuyến nghị.
- Nâng cache PWA lên `hue-shell-v11`.


## Tạo tài khoản bởi Admin và nhập CSV

Admin có thể tạo trực tiếp tài khoản user/mod tại **Tài khoản**, hoặc tải file mẫu `public/templates/mau-tai-khoan-hufm.csv`, điền tối đa 1.000 dòng và tải lên. Các cột bắt buộc là `name`, `email`, `password`; các cột tùy chọn gồm `role`, `phone`, `unit`, `group_name`, `status`. `role` chỉ nhận `user` hoặc `mod`; `status` nhận `approved` hoặc `pending`; `group_name` phải trùng tên nhóm đã tạo trong HUFM.
