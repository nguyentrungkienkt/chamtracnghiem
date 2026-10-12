// Chạy: npm test. Kiểm tra nắn theo ô vuông đen phụ (app/omr.js) với độ lệch tổng hợp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchMarks, fitDisplacement, displacementAt, MARK_MAX_SHIFT } from "../app/omr.js";

const TPL = JSON.parse(readFileSync(new URL("../lib/templates.json", import.meta.url), "utf8")).templates.find((t) => t.id === 2);
const W = TPL.ref_w, H = TPL.ref_h;

test("mẫu có 27 ô vuông phụ và 108 mục", () => {
  assert.equal(TPL.marks.length, 27);
  assert.equal(TPL.items.length, 108);
});

test("ghép mốc với ô vuông gần nhất và bỏ ô quá xa", () => {
  const marks = [[100, 100], [500, 500]];
  const squares = [{ x: 103, y: 98 }, { x: 900, y: 900 }];
  const pairs = matchMarks(squares, marks);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].dx, pairs[0].dy], [3, -2]);
});

test("khớp đa thức bậc hai khôi phục độ lệch đã tạo", () => {
  // độ lệch thật: cong nhẹ theo kiểu ống kính
  const truth = (x, y) => [
    4 * Math.sin((x / W) * Math.PI) + 2 * (y / H),
    -3 * (x / W - 0.5) * (x / W - 0.5) * 4 + 1.5 * Math.cos((y / H) * Math.PI),
  ];
  const pairs = TPL.marks.map(([x, y]) => {
    const [dx, dy] = truth(x, y);
    return { x, y, dx, dy };
  });
  const fit = fitDisplacement(pairs, W, H);
  for (const [x, y] of [[300, 400], [1200, 1800], [800, 1100]]) {
    const [dx, dy] = displacementAt(fit, x, y, W, H);
    const [tx, ty] = truth(x, y);
    assert.ok(Math.abs(dx - tx) < 0.8, `dx ${dx} vs ${tx}`);
    assert.ok(Math.abs(dy - ty) < 0.8, `dy ${dy} vs ${ty}`);
  }
});

test("độ lệch bị chặn trong giới hạn", () => {
  const pairs = TPL.marks.map(([x, y]) => ({ x, y, dx: 200, dy: -200 }));
  const fit = fitDisplacement(pairs, W, H);
  const [dx, dy] = displacementAt(fit, 800, 1100, W, H);
  assert.ok(Math.abs(dx) <= MARK_MAX_SHIFT && Math.abs(dy) <= MARK_MAX_SHIFT);
});

test("khớp đa thức bậc ba khôi phục méo dạng thùng (theo bán kính)", () => {
  const cx0 = W / 2, cy0 = H / 2, R = Math.hypot(cx0, cy0);
  const k = 0.002;  // méo thùng: độ lệch tăng theo r³ (ở góc khoảng 10 px)
  const truth = (x, y) => {
    const dxr = x - cx0, dyr = y - cy0, r2 = (dxr * dxr + dyr * dyr) / (R * R);
    return [-dxr * k * r2 * 6, -dyr * k * r2 * 6];
  };
  const pairs = TPL.marks.map(([x, y]) => {
    const [dx, dy] = truth(x, y);
    return { x, y, dx, dy };
  });
  const fit = fitDisplacement(pairs, W, H);
  for (const [x, y] of [[200, 300], [1400, 1900], [830, 1170]]) {
    const [dx, dy] = displacementAt(fit, x, y, W, H);
    const [tx, ty] = truth(x, y);
    assert.ok(Math.abs(dx - tx) < 0.5 && Math.abs(dy - ty) < 0.5, `${dx},${dy} vs ${tx},${ty}`);
  }
});

test("ngưỡng ô: ô trống độ đen 0.2 không bị tô vàng, ô tô đậm vẫn rõ", async () => {
  const { classify, BLANK, CLEAR, UNCERTAIN } = await import("../lib/grading.js");
  const labels = ["A", "B", "C", "D"];
  assert.equal(classify([0.2, 0.12, 0.1, 0.11], labels).status, BLANK);
  assert.equal(classify([0.6, 0.12, 0.1, 0.11], labels).status, CLEAR);
  assert.equal(classify([0.3, 0.12, 0.1, 0.11], labels).status, UNCERTAIN);
  // ô tô nhạt trên ảnh điện thoại (0.25–0.34) nhưng các ô khác gần như trắng
  assert.equal(classify([0.29, 0.04, 0.03, 0.03], labels).status, CLEAR);
  assert.equal(classify([0.31, 0.01, 0.01, 0.04], labels).status, CLEAR);
});
