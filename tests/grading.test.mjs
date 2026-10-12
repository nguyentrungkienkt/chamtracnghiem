// Chạy: npm test. Dùng hình học mẫu PTLTN mẫu 2 (lib/templates.json) và độ đen tổng hợp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classify, readItems, gradeSheet, decorate, BLANK, CLEAR, UNCERTAIN, MULTIPLE } from "../lib/grading.js";
import { defaultScoring } from "../lib/answer-key.js";

const TPL = JSON.parse(readFileSync(new URL("../lib/templates.json", import.meta.url), "utf8"))
  .templates.find((t) => t.id === 2);
const STRUCT = { p1Count: 12, p2Count: 2, p3Count: 4 };

// Độ đen: ô được tô có điểm HI, các ô khác LO; mục không có trong `marks` là trống
function dark(marks, { hi = 0.9, lo = 0.02 } = {}) {
  const d = {};
  for (const it of TPL.items) {
    const filled = marks[it.key] || [];
    d[it.key] = it.labels.map((lab) => (filled.includes(lab) ? hi : lo));
  }
  return d;
}
// Phiếu thực tế luôn có số báo danh và mã đề được tô; thêm vào để kiểm thử không bị đánh dấu oan
const IDS = {};
for (let i = 1; i <= 8; i++) IDS[`sbd:${i}`] = ["1"];
for (let i = 1; i <= 4; i++) IDS[`code:${i}`] = ["0"];
const readOf = (marks, opts) => readItems(TPL, dark({ ...IDS, ...marks }, opts));

test("phân loại: trống, tô rõ, tô nhiều, tô mờ", () => {
  const L = ["A", "B", "C", "D"];
  assert.equal(classify([0.02, 0.03, 0.01, 0.02], L).status, BLANK);
  assert.equal(classify([0.02, 0.9, 0.02, 0.02], L).status, CLEAR);
  assert.equal(classify([0.9, 0.8, 0.02, 0.02], L).status, MULTIPLE);
  assert.equal(classify([0.25, 0.02, 0.02, 0.02], L).status, UNCERTAIN);
});

test("Phần I: đúng được 1 điểm mỗi câu theo cấu hình, trống tính 0", () => {
  const key = { "p1:1": "A", "p1:2": "B", "p1:3": "C" };
  const r = readOf({ "p1:1": ["A"], "p1:2": ["C"] });        // câu 1 đúng, câu 2 sai, câu 3 trống
  const g = gradeSheet(r, { ...key }, { p1Count: 3, p2Count: 0, p3Count: 0 }, defaultScoring());
  assert.equal(g.parts.p1, 0.25);
  assert.equal(g.questions[1].status, "WRONG");
  assert.equal(g.questions[2].status, "WRONG");
  assert.equal(g.status, "GRADED");
});

test("Phần II: số ý đúng quyết định tỷ lệ điểm theo bảng", () => {
  const keys = { "p2:1:a": "Đ", "p2:1:b": "S", "p2:1:c": "Đ", "p2:1:d": "S",
                 "p2:2:a": "Đ", "p2:2:b": "Đ", "p2:2:c": "Đ", "p2:2:d": "Đ" };
  // câu 1: đúng 4 ý -> 1 điểm; câu 2: đúng 2 ý (a, b) -> 0,25 điểm
  const r = readOf({ "p2:1:a": ["Đ"], "p2:1:b": ["S"], "p2:1:c": ["Đ"], "p2:1:d": ["S"],
                     "p2:2:a": ["Đ"], "p2:2:b": ["Đ"], "p2:2:c": ["S"], "p2:2:d": ["S"] });
  const g = gradeSheet(r, keys, { p1Count: 0, p2Count: 2, p3Count: 0 }, defaultScoring());
  assert.equal(g.parts.p2, 1.25);
  assert.equal(g.questions[0].correct, 4);
  assert.equal(g.questions[1].correct, 2);
});

test("Phần III: '12' đúng khi tô đúng hai cột, sai khi tô thừa", () => {
  const keys = { "p3:1": "12", "p3:2": "12", "p3:3": "12", "p3:4": "12" };
  const ok = readOf({ "p3:1:1": ["1"], "p3:1:2": ["2"] });
  const extra = readOf({ "p3:1:1": ["1"], "p3:1:2": ["2"], "p3:1:3": ["3"] });
  const gOk = gradeSheet(ok, keys, { p1Count: 0, p2Count: 0, p3Count: 1 }, defaultScoring());
  const gBad = gradeSheet(extra, keys, { p1Count: 0, p2Count: 0, p3Count: 1 }, defaultScoring());
  assert.equal(gOk.questions[0].status, "RIGHT");
  assert.equal(gOk.parts.p3, 0.25);
  assert.equal(gBad.questions[0].status, "WRONG");
  assert.equal(gBad.parts.p3, 0);
});

test("Phần III: tô thiếu (chỉ cột 1) thì sai và đỏ đúng các cột của đáp án", () => {
  const keys = { "p3:1": "12" };
  const r = readOf({ "p3:1:1": ["1"] });
  const g = gradeSheet(r, keys, { p1Count: 0, p2Count: 0, p3Count: 1 }, defaultScoring());
  assert.equal(g.questions[0].status, "WRONG");
  const marks = decorate(TPL, r, keys, { p1Count: 0, p2Count: 0, p3Count: 1 });
  const at = (k) => marks.filter((m) => m.key === k).map((m) => m.mark);
  assert.deepEqual(at("p3:1:1"), ["cross"]);       // cột 1: học sinh tô '1', đúng với đáp án, nhưng câu đã sai
  assert.deepEqual(at("p3:1:2"), ["dashedRed"]);   // cột 2: đáp án '2' chưa được tô
});

test("Phần III: ô trống giữa các ô đã tô là cần kiểm tra", () => {
  const keys = { "p3:1": "12" };
  const r = readOf({ "p3:1:2": ["2"] });            // cột 1 trống, cột 2 có số
  const g = gradeSheet(r, keys, { p1Count: 0, p2Count: 0, p3Count: 1 }, defaultScoring());
  assert.equal(g.questions[0].status, "PENDING");
  assert.equal(g.status, "NEEDS_REVIEW");
});

test("ô mờ làm câu chờ người chấm, không tính điểm", () => {
  const keys = { "p1:1": "A" };
  const d = dark(IDS); d["p1:1"] = [0.25, 0.02, 0.02, 0.02];   // tô mờ ở A
  const g = gradeSheet(readItems(TPL, d), keys, { p1Count: 1, p2Count: 0, p3Count: 0 }, defaultScoring());
  assert.equal(g.questions[0].status, "PENDING");
  assert.equal(g.status, "NEEDS_REVIEW");
  assert.equal(g.total, 0);
});

test("ảnh đã chấm: đúng là xanh, sai là đỏ kèm viền xanh nét đứt ở đáp án đúng", () => {
  const keys = { "p1:1": "A", "p1:2": "B" };
  const r = readOf({ "p1:1": ["A"], "p1:2": ["C"] });
  const marks = decorate(TPL, r, keys, { p1Count: 2, p2Count: 0, p3Count: 0 });
  const find = (k, lab) => marks.filter((m) => m.key === k && m.label === lab).map((m) => m.mark);
  assert.deepEqual(find("p1:1", "A"), ["tick"]);
  assert.deepEqual(find("p1:2", "C"), ["cross"]);
  assert.deepEqual(find("p1:2", "B"), ["ghost"]);
});

test("ảnh đã chấm: câu trống chỉ có viền xanh ở đáp án đúng", () => {
  const keys = { "p1:1": "D" };
  const marks = decorate(TPL, readOf({}), keys, { p1Count: 1, p2Count: 0, p3Count: 0 });
  assert.deepEqual(marks.filter((m) => m.key === "p1:1").map((m) => [m.label, m.mark]), [["D", "ghost"]]);
});
