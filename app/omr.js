// Xử lý ảnh phiếu bằng OpenCV.js. Bám theo app/omr.py của bản Windows.
// OpenCV.js chỉ dùng cho: tìm contour, xoay, nắn phối cảnh, morphology. Phần còn lại viết bằng JS thuần.
// Tọa độ: khung chuẩn 1656 x 2344 (xem lib/templates.json). Ảnh xử lý nhỏ 800 px để máy yếu vẫn đủ nhanh.

export const DETECT_W = 800;          // chiều rộng ảnh dùng để dò góc và hướng
export const ORIENT_MIN = 0.6;        // điểm vạch chỉ hướng tối thiểu
export const INNER_RATIO = 0.6;       // đo vùng lõi bubble, bỏ viền
export const CANON_W = 1656, CANON_H = 2344;

export class AlignError extends Error {
  constructor(message, missing = []) { super(message); this.name = "AlignError"; this.missing = missing; }
}

const CORNER_NAMES = { tl: "trên trái", tr: "trên phải", br: "dưới phải", bl: "dưới trái" };

// ---------------------------------------------------------------- mảng điểm ảnh (JS thuần)
export function toGray(cv, mat) {
  // Chuyển Mat RGBA/RGB về xám, trả về Mat mới (người gọi phải delete)
  const g = new cv.Mat();
  if (mat.channels() === 1) mat.copyTo(g);
  else cv.cvtColor(mat, g, mat.channels() === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGB2GRAY);
  return g;
}

function percentile(data, p) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  const target = p * data.length;
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
  return 255;
}

// Trung bình hộp (box) kích thước k x k, biên được kẹp. Dùng integral image.
function boxAverage(src, w, h, k) {
  const r = (k - 1) >> 1;
  const integ = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      integ[(y + 1) * (w + 1) + (x + 1)] = integ[y * (w + 1) + (x + 1)] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const s = integ[(y1 + 1) * (w + 1) + (x1 + 1)] - integ[y0 * (w + 1) + (x1 + 1)]
              - integ[(y1 + 1) * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
      out[y * w + x] = s / ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
  }
  return out;
}

// Ảnh nhị phân bóng tối (giống _dark_density): làm mờ 5x5, lấy ngưỡng theo phân vị 80, trung bình hộp 9x9.
function darkDensity(cv, gray) {
  const w = gray.cols, h = gray.rows;
  const blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
  const paper = percentile(blur.data, 0.8);
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < dark.length; i++) dark[i] = blur.data[i] < 0.5 * paper ? 1 : 0;
  blur.delete();
  return { w, h, dens: boxAverage(dark, w, h, 9) };
}

// ---------------------------------------------------------------- dấu căn chỉnh
// Các khối vuông đặc -> [{x, y, side}]. Lượt thứ hai sau mở hình thái bắt dấu bị dính vào dải đen mép.
export function candidateSquares(cv, gray) {
  const w = gray.cols, h = gray.rows;
  const blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
  const paper = percentile(blur.data, 0.8);
  const bin = new cv.Mat(h, w, cv.CV_8UC1);
  for (let i = 0; i < w * h; i++) bin.data[i] = blur.data[i] < 0.5 * paper ? 255 : 0;
  blur.delete();
  const out = squaresFrom(cv, bin, w);
  const k = Math.max(3, Math.round(0.006 * w) | 1);
  const kernel = cv.Mat.ones(k, k, cv.CV_8U);
  const opened = new cv.Mat();
  cv.morphologyEx(bin, opened, cv.MORPH_OPEN, kernel);
  for (const s of squaresFrom(cv, opened, w)) {
    if (out.every((o) => Math.hypot(s.x - o.x, s.y - o.y) > 0.5 * Math.min(s.side, o.side))) out.push(s);
  }
  kernel.delete(); opened.delete(); bin.delete();
  return out;
}

function squaresFrom(cv, bin, w) {
  const minSide = 0.008 * w, maxSide = 0.08 * w;
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const out = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area >= minSide * minSide * 0.5) {
      const rect = cv.minAreaRect(c);
      const rw = rect.size.width, rh = rect.size.height;
      const okSize = rw > 0 && rh > 0 && rw >= minSide && rw <= maxSide && rh >= minSide && rh <= maxSide;
      const okRatio = okSize && rw / rh >= 0.8 && rw / rh <= 1.25;
      if (okRatio && area / (rw * rh) >= 0.85) out.push({ x: rect.center.x, y: rect.center.y, side: (rw + rh) / 2 });
    }
    c.delete();
  }
  contours.delete(); hier.delete();
  return out;
}

// Bốn dấu ngoài cùng: TL min(x+y), TR max(x-y), BR max(x+y), BL max(y-x)
export function outerCorners(cands) {
  if (cands.length < 4) return null;
  const pick = {
    tl: cands.reduce((a, b) => (b.x + b.y < a.x + a.y ? b : a)),
    tr: cands.reduce((a, b) => (b.x - b.y > a.x - a.y ? b : a)),
    br: cands.reduce((a, b) => (b.x + b.y > a.x + a.y ? b : a)),
    bl: cands.reduce((a, b) => (b.y - b.x > a.y - a.x ? b : a)),
  };
  if (new Set(Object.values(pick)).size < 4) return null;
  return pick;
}

// Dấu gần vị trí chuẩn nhất trong từng góc. Thiếu góc nào thì ném lỗi kèm danh sách góc thiếu.
export function findFiducials(cands, tpl, w, h) {
  const found = {}, missing = [];
  for (const name of ["tl", "tr", "br", "bl"]) {
    const [ux, uy] = tpl.fiducials[name];
    const ex = (ux / tpl.ref_w) * w, ey = (uy / tpl.ref_h) * h;
    let best = null, bestD = Infinity;
    for (const c of cands) {
      if ((name === "tl" || name === "bl") && c.x > w / 2) continue;
      if ((name === "tr" || name === "br") && c.x < w / 2) continue;
      if ((name === "tl" || name === "tr") && c.y > h / 2) continue;
      if ((name === "bl" || name === "br") && c.y < h / 2) continue;
      const d = Math.hypot(c.x - ex, c.y - ey);
      if (d < bestD) { best = c; bestD = d; }
    }
    if (!best || bestD > 0.25 * Math.min(w, h)) missing.push(name);
    else found[name] = { x: best.x, y: best.y };
  }
  if (missing.length) {
    throw new AlignError(`Thiếu dấu căn chỉnh góc ${missing.map((m) => CORNER_NAMES[m]).join(", ")}`, missing);
  }
  return found;
}

// Kiểm tra hình học: không xoay quá 15 độ, đúng hình chữ nhật, đúng tỷ lệ mẫu
export function checkGeometry(f, tpl) {
  const { tl, tr, br, bl } = f;
  if (tr.x <= tl.x || bl.y <= tl.y || br.x <= bl.x || br.y <= tr.y) throw new AlignError("Phiếu bị xoay hoặc lật ngược");
  const angle = (Math.atan2(tr.y - tl.y, tr.x - tl.x) * 180) / Math.PI;
  if (Math.abs(angle) > 15) throw new AlignError(`Phiếu nghiêng ${angle.toFixed(1)} độ`, [], "tilt");
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const top = d(tl, tr), bottom = d(bl, br), left = d(tl, bl), right = d(tr, br);
  if (Math.abs(top - bottom) / top > 0.1 || Math.abs(left - right) / left > 0.1) throw new AlignError("Ảnh méo");
  const [fx, fy] = [tpl.fiducials.tr[0] - tpl.fiducials.tl[0], tpl.fiducials.bl[1] - tpl.fiducials.tl[1]];
  const expected = fx / fy;
  if (Math.abs((top / left) / expected - 1) > 0.12) throw new AlignError("Tỷ lệ khung phiếu không khớp mẫu");
}

// Ma trận khung chuẩn -> ảnh: getPerspectiveTransform(dst=chuẩn, src=ảnh) đọc từ OpenCV, trả về mảng 9 số
function canonToImage(cv, f, tpl) {
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, [f.tl.x, f.tl.y, f.tr.x, f.tr.y, f.br.x, f.br.y, f.bl.x, f.bl.y]);
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [...tpl.fiducials.tl, ...tpl.fiducials.tr, ...tpl.fiducials.br, ...tpl.fiducials.bl]);
  const m = cv.getPerspectiveTransform(dst, src);
  const arr = Array.from(m.data64F);
  src.delete(); dst.delete(); m.delete();
  return arr;
}

// Điểm 0..1: các vạch chỉ hướng của mẫu có đen đúng chỗ không
export function orientationScore(cv, gray, tpl, f) {
  if (!tpl.orient || !tpl.orient.length) return 0;
  const { w, h, dens } = darkDensity(cv, gray);
  const H = canonToImage(cv, f, tpl);
  const r = Math.max(6, Math.round(0.012 * w));
  const vals = [];
  for (const [x, y] of tpl.orient) {
    const d = H[6] * x + H[7] * y + H[8];
    if (Math.abs(d) < 1e-9) { vals.push(0); continue; }
    const px = Math.round((H[0] * x + H[1] * y + H[2]) / d);
    const py = Math.round((H[3] * x + H[4] * y + H[5]) / d);
    let best = 0;
    for (let yy = Math.max(0, py - r); yy <= Math.min(h - 1, py + r); yy++)
      for (let xx = Math.max(0, px - r); xx <= Math.min(w - 1, px + r); xx++)
        best = Math.max(best, dens[yy * w + xx]);
    vals.push(best);
  }
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// Dò góc trên một ảnh (đã xoay đúng hoặc chưa). Trả về {f, cands} hoặc ném lỗi.
function detectOn(cv, gray, tpl) {
  const cands = candidateSquares(cv, gray);
  const f = findFiducials(cands, tpl, gray.cols, gray.rows);
  checkGeometry(f, tpl);
  return f;
}

// Xoay k lần 90 độ ngược chiều kim đồng hồ (giống np.rot90). Trả về Mat mới.
export function rotateK(cv, gray, k) {
  const out = new cv.Mat();
  if (k % 4 === 0) { gray.copyTo(out); return out; }
  let cur = gray;
  for (let i = 0; i < k % 4; i++) {
    const nxt = new cv.Mat();
    cv.rotate(cur, nxt, cv.ROTATE_90_COUNTERCLOCKWISE);
    if (cur !== gray) cur.delete();
    cur = nxt;
  }
  out.delete();
  return cur;
}

// Chọn chiều đúng của phiếu. Trả về {k, f} với f là góc trên ảnh đã xoay k lần (kích thước detect).
export function orientUpright(cv, small, tpl) {
  let best = { k: 0, score: -1, f: null, err: null };
  for (let k = 0; k < 4; k++) {
    const g = rotateK(cv, small, k);
    try {
      const cands = candidateSquares(cv, g);
      const corners = outerCorners(cands);
      if (corners) {
        const score = orientationScore(cv, g, tpl, corners);
        if (score > best.score) best = { k, score, f: null };
      }
    } catch (e) { /* bỏ qua hướng này */ } finally { g.delete(); }
  }
  if (best.score < ORIENT_MIN) {
    throw new AlignError("Không thấy vạch chỉ hướng của mẫu - đưa phiếu thẳng và chụp lại");
  }
  const g = rotateK(cv, small, best.k);
  try {
    const f = detectOn(cv, g, tpl);
    return { k: best.k, f };
  } finally { g.delete(); }
}

// Đọc toàn bộ phiếu: nhận ảnh xám full-res, trả về { aligned (Mat 1656x2344 xám), darkness, k, f }.
export function processPhoto(cv, fullGray, tpl) {
  const scale = DETECT_W / fullGray.cols;
  const smallH = Math.round(fullGray.rows * scale);
  const small = new cv.Mat();
  cv.resize(fullGray, small, new cv.Size(DETECT_W, smallH), 0, 0, cv.INTER_AREA);
  let rotated = null, aligned = null, bg = null;
  try {
    const { k, f: fSmall } = orientUpright(cv, small, tpl);
    // xoay ảnh full-res cùng chiều với ảnh dò
    rotated = rotateK(cv, fullGray, k);
    // kích thước ảnh dò sau khi xoay: k lẻ thì hai cạnh đổi chỗ
    const smallCols = k % 2 ? smallH : DETECT_W, smallRows = k % 2 ? DETECT_W : smallH;
    const sx = rotated.cols / smallCols, sy = rotated.rows / smallRows;
    // dò lại trên ảnh xoay để lấy tọa độ chính xác hơn ở full-res
    const fFull = {};   // tọa độ góc trên ảnh full-res
    for (const n of ["tl", "tr", "br", "bl"]) fFull[n] = { x: fSmall[n].x * sx, y: fSmall[n].y * sy };
    const src = cv.matFromArray(4, 1, cv.CV_32FC2, [fFull.tl.x, fFull.tl.y, fFull.tr.x, fFull.tr.y, fFull.br.x, fFull.br.y, fFull.bl.x, fFull.bl.y]);
    const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [...tpl.fiducials.tl, ...tpl.fiducials.tr, ...tpl.fiducials.br, ...tpl.fiducials.bl]);
    const M = cv.getPerspectiveTransform(src, dst);
    aligned = new cv.Mat();
    cv.warpPerspective(rotated, aligned, M, new cv.Size(tpl.ref_w, tpl.ref_h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    src.delete(); dst.delete(); M.delete();

    // chuẩn hóa ánh sáng: chia cho nền ước lượng (đóng hình thái + làm mờ), giấy ~ 1.0
    bg = new cv.Mat();
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(61, 61));
    cv.morphologyEx(aligned, bg, cv.MORPH_CLOSE, kernel);
    cv.GaussianBlur(bg, bg, new cv.Size(0, 0), 9, 9, cv.BORDER_DEFAULT);
    kernel.delete();
    const n = tpl.ref_w * tpl.ref_h;
    const norm = new Float32Array(n);
    for (let i = 0; i < n; i++) norm[i] = Math.min(1.2, aligned.data[i] / Math.max(bg.data[i], 1));

    const darkness = readDarkness(tpl, norm, tpl.ref_w, tpl.ref_h);
    const alignedOut = aligned;
    aligned = null;                       // quyền sở hữu chuyển cho người gọi
    return { aligned: alignedOut, darkness, k };
  } finally {
    small.delete();
    if (rotated) rotated.delete();
    if (aligned) aligned.delete();
    if (bg) bg.delete();
  }
}

// Điểm đen từng ô: 1 - trung bình vùng lõi trên ảnh đã chuẩn hóa
export function bubbleDarkness(norm, w, cx, cy, radius) {
  const r = Math.max(2, Math.round(radius * INNER_RATIO));
  const x0 = Math.round(cx), y0 = Math.round(cy);
  let sum = 0, n = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const idx = (y0 + dy) * w + (x0 + dx);
      if (idx < 0 || idx >= norm.length) continue;
      sum += norm[idx]; n++;
    }
  }
  if (n === 0) return 0;
  return Math.min(1, Math.max(0, 1 - sum / n));
}

export function readDarkness(tpl, norm, w, h) {
  const out = {};
  for (const it of tpl.items) {
    out[it.key] = it.centers.map(([cx, cy]) => bubbleDarkness(norm, w, cx, cy, it.radius));
  }
  return out;
}

// Chất lượng khung xem trước: độ nét (trung bình chênh lệch điểm ảnh cạnh nhau) và độ sáng
export function frameQuality(gray) {
  const { data, cols: w, rows: h } = gray;
  let sum = 0, cnt = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w - 1; x++) { sum += Math.abs(data[y * w + x + 1] - data[y * w + x]); cnt++; }
  let bright = 0;
  for (let i = 0; i < data.length; i++) bright += data[i];
  return { sharp: sum / Math.max(1, cnt), bright: bright / data.length };
}

// Ngưỡng chất lượng (cần hiệu chỉnh trên máy thật, xem claude/yeu-cau-thiet-bi-va-hieu-nang.md)
export const QUALITY = { sharpMin: 3.0, brightMin: 55, brightMax: 235 };
