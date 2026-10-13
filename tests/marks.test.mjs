// Chạy: npm test. Kiểm tra nắn theo ô vuông đen phụ (app/omr.js): khớp mốc, nội suy độ lệch, ngưỡng ô.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  matchMarks, fitWarp, warpAt, trackPairs, looResidual,
  MARK_MAX_SHIFT, MARK_TRACK_DIST, MARK_TRACK_WIDE, MARK_MIN_PAIRS, outerCorners,
} from "../app/omr.js";
import { classify, BLANK, CLEAR, UNCERTAIN } from "../lib/grading.js";

const TPL = JSON.parse(readFileSync(new URL("../lib/templates.json", import.meta.url), "utf8")).templates.find((t) => t.id === 2);
const W = TPL.ref_w, H = TPL.ref_h;
const anchors = [...TPL.marks, ...Object.values(TPL.fiducials)];

// Tạo các cặp (mốc, vị trí thấy) từ một hàm độ lệch thật
const pairsFrom = (truth, extra = () => [0, 0]) => anchors.map(([x, y]) => {
  const [a, b] = truth(x, y), [c, d] = extra(x, y);
  return { x, y, dx: a + c, dy: b + d };
});

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

test("mốc lệch tới 45 px (ảnh méo) vẫn được ghép, nhưng bán kính cũ 30 px thì bỏ sót", () => {
  const marks = [[500, 500]];
  const squares = [{ x: 545, y: 500 }];
  assert.equal(matchMarks(squares, marks, 30).length, 0);
  assert.equal(matchMarks(squares, marks).length, 1);
});

test("nội suy đi đúng qua từng mốc", () => {
  const truth = (x, y) => [4 * Math.sin((x / W) * Math.PI), 2 + 6 * (y / H) * (y / H)];
  const pairs = pairsFrom(truth);
  const m = fitWarp(pairs, W, H);
  for (const p of pairs) {
    const [dx, dy] = warpAt(m, p.x, p.y);
    assert.ok(Math.abs(dx - p.dx) < 0.01 && Math.abs(dy - p.dy) < 0.01);
  }
});

test("trường cong trơn: nội suy đúng giữa các mốc", () => {
  const truth = (x, y) => [4 * Math.sin((x / W) * Math.PI) + 2 * (y / H), -3 * (x / W - 0.5) ** 2 * 4 + 1.5 * Math.cos((y / H) * Math.PI)];
  const m = fitWarp(pairsFrom(truth), W, H);
  for (const [x, y] of [[300, 400], [1200, 1800], [800, 1100], [200, 2000]]) {
    const [dx, dy] = warpAt(m, x, y);
    const [tx, ty] = truth(x, y);
    assert.ok(Math.abs(dx - tx) < 0.8 && Math.abs(dy - ty) < 0.8, `${dx},${dy} vs ${tx},${ty}`);
  }
});

test("méo dạng thùng: nội suy đúng ở các vùng trong sheet", () => {
  const cx0 = W / 2, cy0 = H / 2, R = Math.hypot(cx0, cy0);
  const k = 0.002;
  const truth = (x, y) => {
    const dxr = x - cx0, dyr = y - cy0, r2 = (dxr * dxr + dyr * dyr) / (R * R);
    return [-dxr * k * r2 * 6, -dyr * k * r2 * 6];
  };
  const m = fitWarp(pairsFrom(truth), W, H);
  for (const [x, y] of [[200, 300], [1400, 1900], [830, 1170]]) {
    const [dx, dy] = warpAt(m, x, y);
    const [tx, ty] = truth(x, y);
    // nội suy mặt mỏng sai khoảng 1 px ở vùng xa mốc với méo bậc ba: chấp nhận được so với lệch cục bộ 8 px
    assert.ok(Math.abs(dx - tx) < 1.5 && Math.abs(dy - ty) < 1.5, `${dx},${dy} vs ${tx},${ty}`);
  }
});

test("độ lệch bị chặn trong giới hạn", () => {
  const m = fitWarp(anchors.map(([x, y]) => ({ x, y, dx: 200, dy: -200 })), W, H);
  const [dx, dy] = warpAt(m, 800, 1100);
  assert.ok(Math.abs(dx) <= MARK_MAX_SHIFT && Math.abs(dy) <= MARK_MAX_SHIFT);
});

test("mốc lệch cục bộ 8 px ở mép dưới: nội suy đúng tại mốc đó, không kéo lệch cả trang", () => {
  const truth = (x, y) => [1.5 * Math.sin((x / W) * Math.PI), 2 + 6 * (y / H) * (y / H)];
  const bump = (x, y) => (x > 1300 && y > 2200 ? [0, 8] : [0, 0]);
  const pairs = pairsFrom(truth, bump);
  const m = fitWarp(pairs, W, H);
  const [, fy] = warpAt(m, 1338, 2282);
  assert.ok(Math.abs(fy - (truth(1338, 2282)[1] + 8)) < 0.05, `dy ${fy}`);
  const [, far] = warpAt(m, 300, 400);
  assert.ok(Math.abs(far - truth(300, 400)[1]) < 1.0, `xa mốc: ${far}`);
});

test("bám lại với mô hình nội suy: mốc lệch 8 px vẫn được nhận", () => {
  const truth = (x, y) => [1.5 * Math.sin((x / W) * Math.PI), 2 + 6 * (y / H) * (y / H)];
  const bump = (x, y) => (x > 1300 && y > 2200 ? [0, 8] : [0, 0]);
  const squares = pairsFrom(truth, bump).map((p) => ({ x: p.x + p.dx, y: p.y + p.dy }));
  const wide = matchMarks(squares, anchors, 30);
  let warp = fitWarp(wide, W, H);
  let tracked = trackPairs(squares, anchors, warp, MARK_TRACK_DIST);
  warp = fitWarp(tracked, W, H);
  tracked = trackPairs(squares, anchors, warp, MARK_TRACK_WIDE);
  assert.ok(tracked.length >= MARK_MIN_PAIRS && tracked.length === anchors.length, `dùng được ${tracked.length}`);
});

test("sai số dự đoán: trường trơn thì nhỏ, có mốc lệch cục bộ thì lớn hơn", () => {
  const truth = (x, y) => [1.5 * Math.sin((x / W) * Math.PI), 2 + 6 * (y / H) * (y / H)];
  const smooth = looResidual(pairsFrom(truth), W, H);
  const bumped = looResidual(pairsFrom(truth, (x, y) => (x > 1300 && y > 2200 ? [0, 8] : [0, 0])), W, H);
  assert.ok(smooth < 0.3, `trơn: ${smooth}`);
  assert.ok(bumped > smooth + 0.5, `có lệch: ${bumped}`);
});

test("ngưỡng ô: ô trống độ đen 0.2 không bị tô vàng, ô tô đậm vẫn rõ", () => {
  const labels = ["A", "B", "C", "D"];
  assert.equal(classify([0.2, 0.12, 0.1, 0.11], labels).status, BLANK);
  assert.equal(classify([0.6, 0.12, 0.1, 0.11], labels).status, CLEAR);
  assert.equal(classify([0.3, 0.12, 0.1, 0.11], labels).status, UNCERTAIN);
  // ô tô nhạt trên ảnh điện thoại (0.25–0.34) nhưng các ô khác gần như trắng
  assert.equal(classify([0.29, 0.04, 0.03, 0.03], labels).status, CLEAR);
  assert.equal(classify([0.31, 0.01, 0.01, 0.04], labels).status, CLEAR);
});

test("góc trên trái bị mất: suy ra từ ba góc còn lại; có dấu gần đó thì lấy dấu đó", () => {
  // phiếu nghiêng nhẹ trên ảnh 800 px rộng: TR, BR, BL nhận được, TL không
  const tr = { x: 759, y: 370 }, br = { x: 750, y: 1370 }, bl = { x: 36, y: 1379 };
  const noise = [{ x: 122, y: 137 }, { x: 400, y: 700 }];   // vết tối không phải dấu
  const c = outerCorners([tr, br, bl, ...noise], 800);
  assert.deepEqual([c.tl.x, c.tl.y], [45, 379]);             // TR + BL - BR
  const withTl = outerCorners([tr, br, bl, { x: 40, y: 383 }], 800);
  assert.deepEqual([withTl.tl.x, withTl.tl.y], [40, 383]);   // dấu thật gần vị trí dự đoán
});
