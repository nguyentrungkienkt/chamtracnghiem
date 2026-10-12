// Chạy: node --test tests/
// Dữ liệu là bảng tổng hợp, không phải đáp án thật.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHeader, parseAnswerRows, p3Error, maxScore, defaultScoring, validateStructure, cellText, findKeys,
} from "../lib/answer-key.js";

const STRUCT = { p1Count: 3, p2Count: 2, p3Count: 2 };

// Tiêu đề giống file mẫu: mã đề, Phần I 1..3, Phần II 1a..2d, Phần III 1..2
function header() {
  const h = ["Đề\\câu", "1", "2", "3"];
  for (const q of [1, 2]) for (const s of ["a", "b", "c", "d"]) h.push(`${q}${s}`);
  h.push("1", "2");
  return h;
}

function row(code, p1, p2, p3) {
  return [code, ...p1, ...p2, ...p3];
}

test("parseHeader phân biệt Phần I và Phần III có cùng tiêu đề số", () => {
  const cols = parseHeader(header());
  assert.deepEqual(cols.p1.map((c) => c.q), [1, 2, 3]);
  assert.equal(cols.p2.length, 8);
  assert.deepEqual(cols.p3.map((c) => c.q), [1, 2]);
  assert.equal(cols.p3[0].col, 1 + 3 + 8);   // cột Phần III nằm sau khối Phần II
});

test("đọc đúng đáp án của các mã đề, giữ số 0 đầu", () => {
  const rows = [
    header(),
    row("000", ["A", "B", "C"], ["D", "S", "D", "S", "S", "S", "D", "D"], [2.25, "12"]),
    row("3102", ["C", "C", "A"], ["S", "S", "S", "S", "D", "D", "D", "D"], ["5", 18]),
  ];
  const r = parseAnswerRows(rows, STRUCT);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.codes, ["000", "3102"]);
  assert.equal(r.keys["000"]["p1:1"], "A");
  assert.equal(r.keys["000"]["p2:1:a"], "Đ");
  assert.equal(r.keys["000"]["p2:1:b"], "S");
  assert.equal(r.keys["000"]["p3:1"], "2,25");
  assert.equal(r.keys["3102"]["p3:2"], "18");
});

test("báo lỗi đáp án Phần I không hợp lệ theo dòng", () => {
  const rows = [header(), row("000", ["A", "E", "C"], ["D", "S", "D", "S", "S", "S", "D", "D"], ["1", "2"])];
  const r = parseAnswerRows(rows, STRUCT);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].item, "p1:2");
  assert.equal(r.errors[0].row, 2);
});

test("báo lỗi mã đề trùng và mã đề sai định dạng", () => {
  const ok = ["A", "A", "A"], p2 = ["D", "D", "D", "D", "D", "D", "D", "D"], p3 = ["1", "2"];
  const rows = [header(), row("000", ok, p2, p3), row("000", ok, p2, p3), row("12", ok, p2, p3)];
  const r = parseAnswerRows(rows, STRUCT);
  assert.ok(r.errors.some((e) => /trùng/.test(e.message)));
  assert.ok(r.errors.some((e) => /3–4 chữ số/.test(e.message)));
});

test("báo lỗi khi file có đáp án vượt số câu đã nhập", () => {
  const rows = [header(), row("000", ["A", "B", "C"], ["D", "S", "D", "S", "S", "S", "D", "D"], ["1", "2"])];
  const r = parseAnswerRows(rows, { p1Count: 2, p2Count: 2, p3Count: 2 });
  assert.ok(r.errors.some((e) => e.item === "p1:3" && /nhiều hơn/.test(e.message)));
});

test("báo thiếu cột khi số câu khai báo lớn hơn file", () => {
  const rows = [header(), row("000", ["A", "B", "C"], ["D", "S", "D", "S", "S", "S", "D", "D"], ["1", "2"])];
  const r = parseAnswerRows(rows, { p1Count: 5, p2Count: 2, p3Count: 2 });
  assert.ok(r.errors.some((e) => e.item === "p1:4" && /Thiếu cột/.test(e.message)));
});

test("quy tắc Phần III: '-' chỉ ở vị trí đầu, ',' chỉ ở vị trí 2 hoặc 3", () => {
  assert.equal(p3Error("-0,1"), "");
  assert.equal(p3Error("12"), "");
  assert.equal(p3Error("2,25"), "");
  assert.notEqual(p3Error("1-2"), "");
  assert.notEqual(p3Error(",1"), "");
  assert.notEqual(p3Error("12345"), "");
  assert.notEqual(p3Error("1x"), "");
  assert.notEqual(p3Error(""), "");
});

test("điểm tối đa theo cấu hình mặc định", () => {
  const m = maxScore({ p1Count: 12, p2Count: 2, p3Count: 4 }, defaultScoring());
  assert.equal(m.p1, 3);       // 12 × 0,25
  assert.equal(m.p2, 2);       // 2 × 1
  assert.equal(m.p3, 1);       // 4 × 0,25
  assert.equal(m.total, 6);
});

test("cấu hình điểm Phần II mặc định khớp yêu cầu", () => {
  const s = defaultScoring().p2Scale;
  assert.equal(s["1"], 0.1);
  assert.equal(s["2"], 0.25);
  assert.equal(s["3"], 0.5);
  assert.equal(s["4"], 1);
});

test("kiểm tra số câu khi tạo phiên", () => {
  assert.deepEqual(validateStructure({ p1Count: 12, p2Count: 2, p3Count: 4 }), []);
  assert.equal(validateStructure({ p1Count: 41, p2Count: 2, p3Count: 4 }).length, 1);
  assert.equal(validateStructure({ p1Count: 12, p2Count: 2, p3Count: 1.5 }).length, 1);
});

test("cellText chuyển số thập phân dùng dấu phẩy", () => {
  assert.equal(cellText(2.25), "2,25");
  assert.equal(cellText(18), "18");
  assert.equal(cellText(null), "");
});

test("tìm đáp án khi Excel làm mất số 0 đầu của mã đề", () => {
  const keys = { "203": { a: 1 }, "1234": { b: 2 } };
  assert.deepEqual(findKeys(keys, "1234"), { b: 2 });   // khớp đúng
  assert.deepEqual(findKeys(keys, "0203"), { a: 1 });   // khớp theo giá trị số
  assert.equal(findKeys(keys, "0999"), undefined);      // không có mã này
});
