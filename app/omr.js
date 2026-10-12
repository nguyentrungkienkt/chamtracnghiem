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

// Dùng khi người chấm đã chỉ hướng phiếu bằng tay (nút Xoay): bỏ qua bước tự đoán chiều.
function forcedOrient(cv, small, tpl, k) {
  const g = rotateK(cv, small, k);
  try { return { k, f: detectOn(cv, g, tpl) }; } finally { g.delete(); }
}

// ---------------------------------------------------------------- nắn theo các ô vuông đen phụ
// Sau khi nắn theo 4 góc, mỗi ô vuông mẫu (tpl.marks) được ghép với ô vuông tìm thấy gần nhất.
// Độ lệch được khớp bằng đa thức bậc hai (6 hệ số cho mỗi trục), rồi ảnh được lấy mẫu lại.
export const MARK_SEARCH_DIST = 30;  // tìm ô vuông gần mốc trong bán kính này (đủ rộng để chứa độ cong)
export const MARK_TRACK_DIST = 6;    // sau khi khớp, chỉ nhận ô vuông nằm trong bán kính này quanh vị trí dự đoán
export const MARK_MAX_SHIFT = 20;    // độ lệch tối đa cho phép ở mọi điểm (px)
export const MARK_MIN_PAIRS = 16;    // ít hơn số này thì giữ nguyên ảnh đã nắn 4 góc (đa thức bậc ba có 10 hệ số)
export const RESID_WARN = 2.5;       // sai số còn lại sau khi nắn (px) từ mức này trở lên: báo chụp lại

// Ghép từng mốc với ô vuông gần nhất. Trả về [{x, y, dx, dy}] với (dx, dy) = vị trí thấy - vị trí mẫu.
export function matchMarks(squares, marks, maxDist = MARK_SEARCH_DIST) {
  const pairs = [];
  for (const m of marks) {
    let best = null, bd = Infinity;
    for (const s of squares) {
      const d = Math.hypot(s.x - m[0], s.y - m[1]);
      if (d < bd) { bd = d; best = s; }
    }
    if (best && bd <= maxDist) pairs.push({ x: m[0], y: m[1], dx: best.x - m[0], dy: best.y - m[1] });
  }
  return pairs;
}

// Bám lại: với mỗi mốc, tìm ô vuông gần vị trí đã được mô hình dự đoán
function trackPairs(squares, anchors, fit, w, h) {
  const pairs = [];
  for (const [x, y] of anchors) {
    const [dx, dy] = displacementAt(fit, x, y, w, h);
    const px = x + dx, py = y + dy;
    let best = null, bd = Infinity;
    for (const s of squares) {
      const d = Math.hypot(s.x - px, s.y - py);
      if (d < bd) { bd = d; best = s; }
    }
    if (best && bd <= MARK_TRACK_DIST) pairs.push({ x, y, dx: best.x - x, dy: best.y - y });
  }
  return pairs;
}

// Cơ sở đa thức bậc ba, chuẩn hóa theo kích thước khung chuẩn.
// Méo của ống kính góc rộng có dạng bậc ba theo bán kính, nên bậc hai không đủ.
const NB = 10;
function polyBasis(x, y, w, h) {
  const u = x / w, v = y / h;
  return [1, u, v, u * u, u * v, v * v, u * u * u, u * u * v, u * v * v, v * v * v];
}

// Giải hệ 6x6 bằng khử Gauss có chọn phần tử trội
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

// Hệ số đa thức của độ lệch theo x và theo y
export function fitDisplacement(pairs, w, h) {
  const A = Array.from({ length: NB }, () => new Array(NB).fill(0));
  const bx = new Array(NB).fill(0), by = new Array(NB).fill(0);
  for (const p of pairs) {
    const f = polyBasis(p.x, p.y, w, h);
    for (let i = 0; i < NB; i++) {
      for (let j = 0; j < NB; j++) A[i][j] += f[i] * f[j];
      bx[i] += f[i] * p.dx;
      by[i] += f[i] * p.dy;
    }
  }
  for (let i = 0; i < NB; i++) A[i][i] += 1e-6;   // ổn định khi số điểm ít
  return { cx: solveLinear(A, bx), cy: solveLinear(A, by) };
}

// Độ lệch tại một điểm, bị chặn trong MARK_MAX_SHIFT
export function displacementAt(fit, x, y, w, h) {
  const f = polyBasis(x, y, w, h);
  const clamp = (v) => Math.max(-MARK_MAX_SHIFT, Math.min(MARK_MAX_SHIFT, v));
  let dx = 0, dy = 0;
  for (let i = 0; i < NB; i++) { dx += fit.cx[i] * f[i]; dy += fit.cy[i] * f[i]; }
  return [clamp(dx), clamp(dy)];
}

// Nắn lại ảnh đã nắn 4 góc theo các ô vuông đen phụ. Trả về {aligned, used, dev}; thiếu điểm thì giữ nguyên.
function refineWithMarks(cv, aligned, tpl) {
  if (!tpl.marks || !tpl.marks.length) return { aligned, used: 0, dev: 0, residual: null };
  const anchors = [...tpl.marks, ...Object.values(tpl.fiducials)];
  const squares = candidateSquares(cv, aligned);
  const wide = matchMarks(squares, anchors, MARK_SEARCH_DIST);
  // độ cong: độ lệch trung bình của các ô vuông so với mẫu, trước khi nắn lại (px khung chuẩn)
  let sq0 = 0;
  for (const p of wide) sq0 += p.dx * p.dx + p.dy * p.dy;
  const dev = wide.length ? Math.sqrt(sq0 / wide.length) : 0;
  if (wide.length < MARK_MIN_PAIRS) return { aligned, used: wide.length, dev, residual: null };
  // lượt 1 khớp mô hình theo mọi ô tìm được, lượt 2 bám lại quanh vị trí dự đoán
  let pairs = wide;
  let fit = fitDisplacement(wide, tpl.ref_w, tpl.ref_h);
  const tracked = trackPairs(squares, anchors, fit, tpl.ref_w, tpl.ref_h);
  if (tracked.length >= MARK_MIN_PAIRS) {
    pairs = tracked;
    fit = fitDisplacement(tracked, tpl.ref_w, tpl.ref_h);
  }
  let se = 0;   // sai số còn lại tại các ô vuông sau khi khớp
  for (const p of pairs) {
    const [fx, fy] = displacementAt(fit, p.x, p.y, tpl.ref_w, tpl.ref_h);
    se += (p.dx - fx) ** 2 + (p.dy - fy) ** 2;
  }
  const residual = Math.sqrt(se / pairs.length);
  const { cx, cy } = fit;
  const w = aligned.cols, h = aligned.rows;

  const mapX = new Float32Array(w * h), mapY = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const v = y / tpl.ref_h;
    for (let x = 0; x < w; x++) {
      const u = x / tpl.ref_w;
      const uu = u * u, uv = u * v, vv = v * v;
      const uuu = uu * u, uuv = uu * v, uvv = u * vv, vvv = vv * v;
      let dx = cx[0] + cx[1] * u + cx[2] * v + cx[3] * uu + cx[4] * uv + cx[5] * vv + cx[6] * uuu + cx[7] * uuv + cx[8] * uvv + cx[9] * vvv;
      let dy = cy[0] + cy[1] * u + cy[2] * v + cy[3] * uu + cy[4] * uv + cy[5] * vv + cy[6] * uuu + cy[7] * uuv + cy[8] * uvv + cy[9] * vvv;
      dx = dx > MARK_MAX_SHIFT ? MARK_MAX_SHIFT : dx < -MARK_MAX_SHIFT ? -MARK_MAX_SHIFT : dx;
      dy = dy > MARK_MAX_SHIFT ? MARK_MAX_SHIFT : dy < -MARK_MAX_SHIFT ? -MARK_MAX_SHIFT : dy;
      mapX[y * w + x] = x + dx;
      mapY[y * w + x] = y + dy;
    }
  }
  const map1 = new cv.Mat(h, w, cv.CV_32FC1), map2 = new cv.Mat(h, w, cv.CV_32FC1);
  map1.data32F.set(mapX); map2.data32F.set(mapY);
  const out = new cv.Mat();
  cv.remap(aligned, out, map1, map2, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
  map1.delete(); map2.delete(); aligned.delete();
  return { aligned: out, used: pairs.length, dev, residual };
}

// Đọc toàn bộ phiếu: nhận ảnh xám full-res, trả về { aligned (Mat 1656x2344 xám), darkness, k, f }.
export function processPhoto(cv, fullGray, tpl, forcedK = null) {
  const scale = DETECT_W / fullGray.cols;
  const smallH = Math.round(fullGray.rows * scale);
  const small = new cv.Mat();
  cv.resize(fullGray, small, new cv.Size(DETECT_W, smallH), 0, 0, cv.INTER_AREA);
  let rotated = null, aligned = null, bg = null, marks = 0, dev = 0, residual = null;
  try {
    const { k, f: fSmall } = forcedK == null ? orientUpright(cv, small, tpl) : forcedOrient(cv, small, tpl, forcedK);
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
    const refined = refineWithMarks(cv, aligned, tpl);
    aligned = refined.aligned;
    marks = refined.used;
    dev = refined.dev;
    residual = refined.residual;

    // chuẩn hóa ánh sáng: chia cho nền ước lượng (đóng hình thái + làm mờ), giấy ~ 1.0
    // Nền tính trên ảnh nhỏ 1/4 rồi phóng to lại: nền vốn trơn nên kết quả gần như giống, nhưng nhanh hơn nhiều trên điện thoại.
    const tiny = new cv.Mat(), tinyBg = new cv.Mat(), kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(16, 16));
    cv.resize(aligned, tiny, new cv.Size(Math.round(tpl.ref_w / 4), Math.round(tpl.ref_h / 4)), 0, 0, cv.INTER_AREA);
    cv.morphologyEx(tiny, tinyBg, cv.MORPH_CLOSE, kernel);
    cv.GaussianBlur(tinyBg, tinyBg, new cv.Size(0, 0), 2.25, 2.25, cv.BORDER_DEFAULT);
    bg = new cv.Mat();
    cv.resize(tinyBg, bg, new cv.Size(tpl.ref_w, tpl.ref_h), 0, 0, cv.INTER_LINEAR);
    tiny.delete(); tinyBg.delete(); kernel.delete();
    const n = tpl.ref_w * tpl.ref_h;
    const norm = new Float32Array(n);
    for (let i = 0; i < n; i++) norm[i] = Math.min(1.2, aligned.data[i] / Math.max(bg.data[i], 1));

    const darkness = readDarkness(tpl, norm, tpl.ref_w, tpl.ref_h);
    const alignedOut = aligned;
    aligned = null;                       // quyền sở hữu chuyển cho người gọi
    return { aligned: alignedOut, darkness, k, marks, dev, residual };
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
