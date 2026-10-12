// Xuất kết quả: bảng điểm CSV và ảnh đã chấm. Mỗi bài có SBD (nếu đọc được) để phân biệt học sinh.
import { sheets } from "./db.js";
import { gradedBlob, sheetSbd } from "./review.js";
import { getTemplate } from "./templates.js";

function csvCell(v) {
  const s = String(v ?? "");
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const num = (x) => Number(x).toFixed(2).replace(".", ",");

// Bảng điểm: dấu chấm phẩy làm dấu phân cách, dấu phẩy làm dấu thập phân (đúng với Excel tiếng Việt).
// rows: các bài, mỗi bài đã có trường sbd.
export function buildCsv(session, rows) {
  const head = ["STT", "SBD", "Mã đề", "Điểm Phần I", "Điểm Phần II", "Điểm Phần III", "Tổng", "Trạng thái", "Ghi chú"];
  const body = [...rows].sort((a, b) => a.createdAt - b.createdAt).map((s, i) => [
    i + 1, s.sbd || "", s.code, num(s.parts.p1), num(s.parts.p2), num(s.parts.p3), num(s.total),
    s.status === "GRADED" ? "Đã chấm" : "Cần xem", (s.warnings || []).join("; "),
  ]);
  const lines = [head, ...body].map((r) => r.map(csvCell).join(";")).join("\r\n");
  return "﻿" + lines + "\r\n";
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function exportCsv(session) {
  const list = await sheets.bySession(session.id);
  const tpl = await getTemplate(session.template);
  const rows = list.map((s) => ({ ...s, sbd: sheetSbd(tpl, s) }));
  const csv = buildCsv(session, rows);
  download(new Blob([csv], { type: "text/csv;charset=utf-8" }), `ket-qua-${safe(session.name)}.csv`);
  return list.length;
}

// Tên file ảnh: có SBD thì kèm SBD và mã đề, để biết ảnh của ai
export function imageName(index, sbd, code) {
  const n = String(index).padStart(3, "0");
  return sbd ? `bai-${n}-sbd-${sbd}-ma-${code}.jpg` : `bai-${n}-ma-${code}.jpg`;
}

// Xuất ảnh đã chấm: thử chia sẻ nhiều ảnh cùng lúc, nếu trình duyệt không hỗ trợ thì tải từng ảnh.
export async function exportImages(session, onProgress) {
  const list = (await sheets.bySession(session.id)).sort((a, b) => a.createdAt - b.createdAt);
  const tpl = await getTemplate(session.template);
  const files = [];
  for (let i = 0; i < list.length; i++) {
    onProgress && onProgress(i + 1, list.length);
    const blob = await gradedBlob(session, list[i]);
    files.push(new File([blob], imageName(i + 1, sheetSbd(tpl, list[i]), list[i].code), { type: "image/jpeg" }));
  }
  if (navigator.canShare && navigator.canShare({ files }) && navigator.share) {
    try { await navigator.share({ files, title: session.name }); return files.length; } catch (e) { if (e.name === "AbortError") return 0; }
  }
  for (const f of files) download(f, f.name);
  return files.length;
}

function safe(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "phien";
}
