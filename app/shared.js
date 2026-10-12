// Hàm dùng chung cho các màn hình
export function fmt(n) {
  return Number(n).toLocaleString("vi-VN", { maximumFractionDigits: 2 });
}

// Dòng điểm in lên ảnh đã chấm
export function scoreLines(sheet, session) {
  const p = sheet.parts;
  const max = session.maxTotal;
  return [
    `Phần I: ${fmt(p.p1)}   Phần II: ${fmt(p.p2)}   Phần III: ${fmt(p.p3)}`,
    `Tổng điểm: ${fmt(sheet.total)} / ${fmt(max)}   Mã đề ${sheet.code}`,
  ];
}
