# Chấm trắc nghiệm (bản điện thoại)

Ứng dụng web chấm phiếu trắc nghiệm bằng camera. Chạy hoàn toàn trên điện thoại:
không có máy chủ, không đồng bộ, dữ liệu chỉ nằm trên máy.

## Dùng thử
1. Mở đường link GitHub Pages của repo (cần HTTPS để dùng camera).
2. Android (Chrome): menu ⋮ → "Thêm vào Màn hình chính". iPhone (Safari): nút chia sẻ → "Thêm vào Màn hình chính".

## Hiện có
- Tạo phiên chấm: tên, loại phiếu (PTLTN mẫu 2, CV1239), số câu và điểm từng phần, bảng điểm Phần II.
- Nhập đáp án từ file Excel theo mã đề (định dạng "đảo đề"), kiểm tra và báo lỗi theo dòng.
- Lưu phiên trên máy, xem và xóa phiên.

## Sẽ làm
- Chấm bằng camera (tự chụp khi đủ 4 góc), tô màu ảnh đã chấm.
- Kiểm tra ô vàng, danh sách bài, xuất ảnh và CSV.
- Nhập đáp án bằng tay và bằng mã QR.

## Phát triển
- `lib/answer-key.js`: đọc và kiểm tra đáp án, tính điểm. Không phụ thuộc giao diện.
- `app/`: giao diện và lưu trữ cục bộ.
- Kiểm thử: `npm test` (cần Node 18 trở lên).

## Lưu ý dữ liệu
Repo này công khai. Không đưa vào repo đáp án thật, ảnh phiếu thật hay danh sách học sinh.
