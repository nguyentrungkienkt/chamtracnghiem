// Dò 4 ô vuông căn chỉnh trên khung hình camera (dùng OpenCV.js đã nạp sẵn trên trang).
// Lấy từ bản trước của omr.js (commit 67b14a5). Chỉ giữ các hàm dò góc, không có đọc bubble.

// Xử lý ảnh phiếu bằng OpenCV.js. Bám theo app/omr.py của bản Windows.
// OpenCV.js chỉ dùng cho: tìm contour, xoay, nắn phối cảnh, morphology. Phần còn lại viết bằng JS thuần.
// Tọa độ: khung chuẩn 1656 x 2344 (xem lib/templates.json). Ảnh xử lý nhỏ 800 px để máy yếu vẫn đủ nhanh.

export const DETECT_W = 800;          // chiều rộng ảnh dùng để dò góc và hướng
export const ORIENT_MIN = 0.6;        // điểm vạch chỉ hướng tối thiểu
export const ORIENT_RADIUS = 0.03;     // bán kính tìm vạch chỉ hướng, tỷ lệ theo chiều rộng ảnh dò (trước đây 0.012: quá hẹp khi ảnh méo)
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

// Góc trên trái thường bị mờ hoặc lệch sáng nên không luôn được nhận ra. Dự đoán từ ba góc còn lại
// (hình bình hành: TL = TR + BL - BR); nếu có dấu gần vị trí dự đoán thì lấy dấu đó, không thì dùng vị trí dự đoán.
const TL_TOL = 0.12;   // bán kính tìm dấu quanh vị trí dự đoán, tỷ lệ theo cạnh ngắn của ảnh dò
function topLeftFrom(cands, tr, br, bl, tol) {
  const pred = { x: tr.x + bl.x - br.x, y: tr.y + bl.y - br.y };
  let best = null, bd = Infinity;
  for (const c of cands) {
    const d = Math.hypot(c.x - pred.x, c.y - pred.y);
    if (d < bd) { bd = d; best = c; }
  }
  return best && bd <= tol ? { x: best.x, y: best.y } : pred;
}

// Ba dấu ngoài cùng (TR max(x-y), BR max(x+y), BL max(y-x)) và góc TL suy ra. Trả về null nếu không đủ.
export function outerCorners(cands, w) {
  if (cands.length < 3) return null;
  const tr = cands.reduce((a, b) => (b.x - b.y > a.x - a.y ? b : a));
  const br = cands.reduce((a, b) => (b.x + b.y > a.x + a.y ? b : a));
  const bl = cands.reduce((a, b) => (b.y - b.x > a.y - a.x ? b : a));
  if (new Set([tr, br, bl]).size < 3) return null;
  const tl = topLeftFrom(cands, tr, br, bl, TL_TOL * w);
  return { tl, tr, br, bl };
}

