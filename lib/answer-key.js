// Đọc và kiểm tra bảng đáp án theo mã đề (định dạng file "đảo đề").
// Hàm thuần: không đụng DOM, không đọc file. Tệp Excel được đọc ở app.js rồi truyền mảng dòng vào đây.
//
// Quy ước item_key (giống bản Windows):
//   p1:q        Phần I, câu q          giá trị A|B|C|D
//   p2:q:s      Phần II, câu q, ý s    giá trị Đ|S  (s = a|b|c|d)
//   p3:q        Phần III, câu q        chuỗi, ví dụ "12", "-0,1"

export const SUB_LETTERS = ["a", "b", "c", "d"];
export const OPTIONS = ["A", "B", "C", "D"];
export const P3_POSITIONS = 4;

const CODE_RE = /^\d{3,4}$/;

// Chuyển giá trị ô Excel về chuỗi: số 18 -> "18", "2.25" -> "2,25"
export function cellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v).replace(".", ",");
  return String(v).trim();
}

// Xác định cột của từng item từ dòng tiêu đề.
// Tiêu đề số đứng trước khối "1a..8d" là Phần I; tiêu đề số đứng sau khối đó là Phần III.
export function parseHeader(headers) {
  const p1 = [], p2 = [], p3 = [];
  let seenP2 = false, afterP2 = false;
  headers.forEach((raw, col) => {
    if (col === 0) return;                     // cột mã đề
    const h = cellText(raw).toLowerCase();
    if (h === "") return;
    let m = h.match(/^([1-8])([a-d])$/);
    if (m) {
      seenP2 = true;
      p2.push({ col, q: Number(m[1]), sub: m[2] });
      return;
    }
    if (/^\d+$/.test(h)) {
      if (seenP2) afterP2 = true;
      if (afterP2) p3.push({ col, q: Number(h) });
      else p1.push({ col, q: Number(h) });
    }
  });
  return { p1, p2, p3 };
}

// Kiểm tra một chuỗi Phần III theo quy tắc của mẫu phiếu:
// "-" chỉ ở vị trí 1; "," chỉ ở vị trí 2 hoặc 3; còn lại là chữ số; tối đa P3_POSITIONS ký tự.
export function p3Error(v, positions = P3_POSITIONS) {
  if (v === "") return "để trống";
  if (v.length > positions) return `dài hơn ${positions} ký tự`;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === "-") {
      if (i !== 0) return "dấu '-' chỉ được ở vị trí đầu";
    } else if (ch === ",") {
      if (i !== 1 && i !== 2) return "dấu ',' chỉ được ở vị trí 2 hoặc 3";
    } else if (!/^\d$/.test(ch)) {
      return `ký tự '${ch}' không hợp lệ`;
    }
  }
  return "";
}

// rows: mảng dòng (mỗi dòng là mảng ô), dòng đầu là tiêu đề.
// structure: { p1Count, p2Count, p3Count }
// Trả về { keys: {mã đề: {item_key: giá trị}}, codes: [...], errors: [{row, code, item, message}] }
export function parseAnswerRows(rows, structure) {
  const errors = [];
  const keys = {};
  const codes = [];
  if (!rows || rows.length < 2) {
    errors.push({ row: 0, code: "", item: "", message: "File không có dòng đáp án nào" });
    return { keys, codes, errors };
  }
  const cols = parseHeader(rows[0]);
  const { p1Count, p2Count, p3Count } = structure;

  // Kiểm tra số câu có đủ cột trong file không
  const hasP1 = new Set(cols.p1.map((c) => c.q));
  const hasP2 = new Set(cols.p2.map((c) => `${c.q}${c.sub}`));
  const hasP3 = new Set(cols.p3.map((c) => c.q));
  for (let q = 1; q <= p1Count; q++) if (!hasP1.has(q)) errors.push({ row: 1, code: "", item: `p1:${q}`, message: `Thiếu cột câu ${q} Phần I` });
  for (let q = 1; q <= p2Count; q++) for (const s of SUB_LETTERS) {
    if (!hasP2.has(`${q}${s}`)) errors.push({ row: 1, code: "", item: `p2:${q}:${s}`, message: `Thiếu cột câu ${q}${s} Phần II` });
  }
  for (let q = 1; q <= p3Count; q++) if (!hasP3.has(q)) errors.push({ row: 1, code: "", item: `p3:${q}`, message: `Thiếu cột câu ${q} Phần III` });

  // Cột vượt số câu đã khai báo: báo lỗi, không bỏ qua im lặng
  for (const c of cols.p1) if (c.q > p1Count) {
    if (rows.slice(1).some((r) => cellText(r[c.col]) !== "")) errors.push({ row: 1, code: "", item: `p1:${c.q}`, message: `File có đáp án câu ${c.q} Phần I, nhiều hơn số câu đã nhập (${p1Count})` });
  }
  for (const c of cols.p2) if (c.q > p2Count) {
    if (rows.slice(1).some((r) => cellText(r[c.col]) !== "")) errors.push({ row: 1, code: "", item: `p2:${c.q}:${c.sub}`, message: `File có đáp án câu ${c.q} Phần II, nhiều hơn số câu đã nhập (${p2Count})` });
  }
  for (const c of cols.p3) if (c.q > p3Count) {
    if (rows.slice(1).some((r) => cellText(r[c.col]) !== "")) errors.push({ row: 1, code: "", item: `p3:${c.q}`, message: `File có đáp án câu ${c.q} Phần III, nhiều hơn số câu đã nhập (${p3Count})` });
  }

  const seen = new Set();
  rows.slice(1).forEach((r, idx) => {
    const rowNo = idx + 2;                          // số dòng trong Excel
    const code = cellText(r[0]);
    if (code === "" && r.every((v) => cellText(v) === "")) return;   // dòng trống
    const bad = (item, message) => errors.push({ row: rowNo, code, item, message });
    if (!CODE_RE.test(code)) { bad("", `mã đề '${code}' phải gồm 3–4 chữ số`); return; }
    if (seen.has(code)) { bad("", `mã đề ${code} bị trùng`); return; }
    seen.add(code);
    codes.push(code);
    const k = {};

    for (let q = 1; q <= p1Count; q++) {
      const col = cols.p1.find((c) => c.q === q);
      const v = col ? cellText(r[col.col]).toUpperCase() : "";
      if (!OPTIONS.includes(v)) bad(`p1:${q}`, `câu ${q} Phần I: '${v}' không phải A–D`);
      k[`p1:${q}`] = v;
    }
    for (let q = 1; q <= p2Count; q++) for (const s of SUB_LETTERS) {
      const col = cols.p2.find((c) => c.q === q && c.sub === s);
      let v = col ? cellText(r[col.col]).toUpperCase() : "";
      if (v === "D" || v === "Đ") v = "Đ";
      if (v !== "Đ" && v !== "S") bad(`p2:${q}:${s}`, `câu ${q}${s} Phần II: '${v}' phải là D (đúng) hoặc S (sai)`);
      k[`p2:${q}:${s}`] = v;
    }
    for (let q = 1; q <= p3Count; q++) {
      const col = cols.p3.find((c) => c.q === q);
      const v = col ? cellText(r[col.col]) : "";
      const e = p3Error(v);
      if (e) bad(`p3:${q}`, `câu ${q} Phần III: '${v}' ${e}`);
      k[`p3:${q}`] = v;
    }
    keys[code] = k;
  });
  return { keys, codes, errors };
}

// Điểm tối đa theo cấu hình, tính bằng đơn vị 1/100 để tránh sai số số thực.
// scoring: { p1PerQ, p2PerQ, p2Scale: {"1":0.1,"2":0.25,"3":0.5,"4":1,"0":0}, p3PerQ }
export function maxScore(structure, scoring) {
  const h = (x) => Math.round(Number(x) * 100);
  const p1 = structure.p1Count * h(scoring.p1PerQ);
  const p2 = structure.p2Count * h(scoring.p2PerQ);
  const p3 = structure.p3Count * h(scoring.p3PerQ);
  return { p1: p1 / 100, p2: p2 / 100, p3: p3 / 100, total: (p1 + p2 + p3) / 100 };
}

// Cấu hình điểm mặc định theo yêu cầu: 1 ý 0,1; 2 ý 0,25; 3 ý 0,5; 4 ý 1
export function defaultScoring() {
  return {
    p1PerQ: 0.25,
    p2PerQ: 1,
    p2Scale: { "0": 0, "1": 0.1, "2": 0.25, "3": 0.5, "4": 1 },
    p3PerQ: 0.25,
  };
}

// Kiểm tra dữ liệu nhập khi tạo phiên. Trả về mảng thông báo lỗi (rỗng là hợp lệ).
export function validateStructure(s) {
  const errs = [];
  const int = (v) => Number.isInteger(v) && v >= 0;
  if (!int(s.p1Count) || s.p1Count > 40) errs.push("Số câu Phần I phải là số nguyên từ 0 đến 40");
  if (!int(s.p2Count) || s.p2Count > 8) errs.push("Số câu Phần II phải là số nguyên từ 0 đến 8");
  if (!int(s.p3Count) || s.p3Count > 6) errs.push("Số câu Phần III phải là số nguyên từ 0 đến 6");
  return errs;
}

// Tìm đáp án theo mã đề đọc từ phiếu (luôn 4 chữ số). Excel hay lưu mã số làm số nên mất số 0 đầu:
// "0203" có thể nằm trong file thành "203". Khớp đúng trước; nếu không có thì khớp theo giá trị số, và chỉ khi duy nhất.
export function findKeys(keys, code) {
  if (!keys || !code) return undefined;
  if (keys[code]) return keys[code];
  const n = Number(code);
  const same = Object.keys(keys).filter((k) => Number(k) === n);
  return same.length === 1 ? keys[same[0]] : undefined;
}
