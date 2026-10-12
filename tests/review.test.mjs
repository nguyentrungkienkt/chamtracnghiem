// Sửa tay và đọc mã đề. Dùng hình học PTLTN mẫu 2 và độ đen tổng hợp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readItems, applyOverrides, readDigits, gradeSheet, BLANK, CLEAR } from "../lib/grading.js";
import { defaultScoring } from "../lib/answer-key.js";

const TPL = JSON.parse(readFileSync(new URL("../lib/templates.json", import.meta.url), "utf8"))
  .templates.find((t) => t.id === 2);

// Phiếu thực tế luôn có số báo danh và mã đề được tô
const IDS = {};
for (let i = 1; i <= 8; i++) IDS[`sbd:${i}`] = ["1"];
for (let i = 1; i <= 4; i++) IDS[`code:${i}`] = ["0"];

function dark(marks) {
  const d = {};
  marks = { ...IDS, ...marks };
  for (const it of TPL.items) {
    const f = marks[it.key] || [];
    d[it.key] = it.labels.map((lab) => (f.includes(lab) ? 0.9 : 0.02));
  }
  return d;
}

test("sửa tay: chọn lại đáp án của câu mờ, câu được tính lại", () => {
  const d = dark({ "p1:1": ["A"], "p1:2": ["B"] });
  d["p1:1"] = [0.3, 0.25, 0.02, 0.02];   // A, B gần nhau -> cần xem
  let read = readItems(TPL, d);
  const keys = { "p1:1": "B", "p1:2": "B" };
  const structure = { p1Count: 2, p2Count: 0, p3Count: 0 };
  assert.equal(gradeSheet(read, keys, structure, defaultScoring()).status, "NEEDS_REVIEW");
  read = applyOverrides(read, { "p1:1": "B" });
  const g = gradeSheet(read, keys, structure, defaultScoring());
  assert.equal(g.status, "GRADED");
  assert.equal(g.parts.p1, 0.5);
});

test("sửa tay để trống: câu thành trống và tính 0", () => {
  const d = dark({ "p1:1": ["A"] });
  const read = applyOverrides(readItems(TPL, d), { "p1:1": "" });
  assert.equal(read["p1:1"].status, BLANK);
});

test("applyOverrides không đổi bản đọc gốc", () => {
  const d = dark({ "p1:1": ["A"] });
  const base = readItems(TPL, d);
  applyOverrides(base, { "p1:1": "C" });
  assert.equal(base["p1:1"].status, CLEAR);
  assert.equal(base["p1:1"].suggestion, "A");
});

test("mã đề đọc từ ô chữ số, thiếu một ô thì không ok", () => {
  const marks = {};
  const digits = ["3", "1", "0", "2"];
  digits.forEach((dgt, i) => { marks[`code:${i + 1}`] = [dgt]; });
  // dark() đã thêm mã đề mặc định, phần ghi đè ở trên thắng
  const read = readItems(TPL, dark(marks));
  const ok = readDigits(read, "code", 4);
  assert.equal(ok.value, "3102");
  assert.equal(ok.ok, true);
  // code:2..4 để trống (ghi đè mặc định của dark())
  const partial = readItems(TPL, dark({ "code:1": ["3"], "code:2": [], "code:3": [], "code:4": [] }));
  const bad = readDigits(partial, "code", 4);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unread, [2, 3, 4]);
});
