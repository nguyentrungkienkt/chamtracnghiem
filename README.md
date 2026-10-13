# Quét phiếu trắc nghiệm (điện thoại)

Ứng dụng web trên điện thoại, dùng để quét ảnh phiếu và gửi lên Google Drive. Điện thoại không chấm. Việc chấm và kiểm tra làm trên máy Windows.

## Chức năng
- **Phiên:** tạo phiên chấm (tên, loại phiếu). Mỗi phiên được gửi lên Drive dưới dạng `phien_<id>.json` để máy Windows đồng bộ.
- **Quét:** mở camera sau, chụp ảnh phiếu. Ảnh được lưu vào hàng đợi trên máy và gửi lên Drive khi có mạng.
- **Kết nối:** nhập địa chỉ relay và mã truy cập do quản trị cấp, kiểm tra kết nối, gửi lại các mục đang chờ.

## Cấu trúc
- `index.html`, `styles.css`: giao diện.
- `js/app.js`: các màn hình và luồng quét.
- `js/db.js`: hàng đợi gửi trong IndexedDB, không mất khi mất mạng.
- `js/relay.js`: gọi relay Drive. Địa chỉ và mã truy cập lưu trên máy, không nằm trong mã nguồn.
- `js/corners.js`: dò 4 ô vuông căn chỉnh trên khung hình (OpenCV.js, nạp trên trang). Khi thấy đủ 4 ô và phiếu đứng yên 3 giây thì tự chụp, rồi nghỉ 3 giây để thay phiếu.
- `sw.js`, `manifest.webmanifest`: chạy được như ứng dụng và mở được khi mất mạng. Khi sửa mã, tăng `CACHE` trong `sw.js`.
- `relay/Code.gs`: Apps Script chạy dưới tài khoản quản trị, giữ quyền Drive.

## Cài đặt relay (một lần)
1. Tạo thư mục gốc trên Drive chung, lấy ID từ đường dẫn.
2. Tạo dự án Apps Script, dán `relay/Code.gs`.
3. Script properties: `ROOT_FOLDER_ID` = ID thư mục gốc; `CODES` = JSON `{"<mã>": "<tên người chấm>"}`.
4. Deploy → Web app, Execute as: Me, Who has access: Anyone. Lấy URL `/exec`.

## Chưa có
- Đồng bộ phiên và loại phiếu từ máy Windows về điện thoại.
- Ứng dụng Windows (chấm, nhập đáp án, xuất kết quả, xóa ảnh trên Drive).
- Kiểm thử trên thiết bị thật: camera và luồng gửi ảnh chưa được thử.

## Lưu ý
Repo này công khai. Không commit URL relay, mã truy cập, đáp án thật hay ảnh phiếu thật.
