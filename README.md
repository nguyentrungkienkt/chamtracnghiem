# Chấm trắc nghiệm (bản điện thoại)

Ứng dụng web chấm phiếu trắc nghiệm bằng camera. Chạy hoàn toàn trên điện thoại:
không có máy chủ, không đồng bộ, dữ liệu chỉ nằm trên máy.

## Dùng thử
1. Mở đường link GitHub Pages của repo (cần HTTPS để dùng camera).
2. Android (Chrome): menu ⋮ → "Thêm vào Màn hình chính". iPhone (Safari): nút chia sẻ → "Thêm vào Màn hình chính".

## Hiện có
- Tạo phiên chấm: tên, số câu và điểm từng phần, bảng điểm Phần II.
- Nhập đáp án từ file Excel theo mã đề (định dạng "đảo đề"), kiểm tra và báo lỗi theo dòng.
- Chấm bằng camera: tự chụp khi thấy đủ 4 góc và phiếu đứng yên khoảng 3 giây. Xử lý ảnh bằng OpenCV.js, chấm ngay trên máy.
- Ảnh đã chấm: xanh = đúng, đỏ = sai, viền xanh nét đứt = đáp án đúng, vàng = cần xem.
- Danh sách bài, xem lại từng bài, sửa tay ô đọc sai, xuất ảnh và CSV.
- Lưu phiên trên máy, xem và xóa phiên.

## Chưa có / cần kiểm tra
- Chưa kiểm thử trên thiết bị thật. Phần camera và OpenCV.js chưa chạy được trong môi trường phát triển; cần thử trên Samsung A26, sau đó A12 và iPhone 6s/SE.
- Chưa có chỉnh góc thủ công trên điện thoại.
- Nhập đáp án bằng mã QR: chưa làm.

## Phát triển
- `lib/answer-key.js`: đọc và kiểm tra đáp án theo mã đề, tính điểm tối đa.
- `lib/grading.js`: phân loại ô (trống, tô rõ, tô nhiều, mờ), chấm theo quy tắc đã chốt, và danh sách nét vẽ cho ảnh đã chấm. Không phụ thuộc camera hay giao diện.
- `lib/templates.json`: hình học hai mẫu phiếu (tọa độ ô, nhãn, bán kính). Xuất từ bản Windows, không có dữ liệu học sinh.
- `app/`: giao diện và lưu trữ cục bộ.
- Kiểm thử: `npm test` (cần Node 18 trở lên).

## Lưu ý dữ liệu
Repo này công khai. Không đưa vào repo đáp án thật, ảnh phiếu thật hay danh sách học sinh.
