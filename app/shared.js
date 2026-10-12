// Hàm dùng chung cho các màn hình
export function fmt(n) {
  return Number(n).toLocaleString("vi-VN", { maximumFractionDigits: 2 });
}

// Dòng điểm in lên ảnh đã chấm: SBD (nếu đọc được), mã đề, tổng và điểm từng phần
export function scoreLines(sheet, session) {
  const p = sheet.parts;
  const max = session.maxTotal;
  return [
    `SBD: ${sheet.sbd || "chưa đọc"}   Mã đề: ${sheet.code}   Tổng: ${fmt(sheet.total)} / ${fmt(max)}`,
    `Phần I: ${fmt(p.p1)}   Phần II: ${fmt(p.p2)}   Phần III: ${fmt(p.p3)}`,
  ];
}
