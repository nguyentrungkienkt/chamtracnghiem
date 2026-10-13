// Luồng nền: nạp OpenCV.js, dò 4 ô vuông trên khung hình camera và nắn phối cảnh ảnh chụp.
// Chạy riêng để giao diện không bị đứng khi nạp OpenCV.js hoặc xử lý từng khung.

const CV_SOURCES = [
  "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js",
  "https://unpkg.com/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js",
];

let M = null; // hàm từ corners.js

async function init() {
  let ok = false;
  for (const url of CV_SOURCES) {
    try { importScripts(url); ok = true; break; } catch (e) { /* thử nguồn kế tiếp */ }
  }
  if (!ok) throw new Error("không tải được OpenCV.js, kiểm tra mạng");
  while (!(self.cv && self.cv.Mat)) await new Promise((r) => setTimeout(r, 100));
  // corners.js dùng cú pháp export; bỏ từ khóa export rồi gói trong hàm.
  const src = await (await fetch(new URL("./corners.js", self.location.href))).text();
  const body = src.replace(/^export\s+/gm, "");
  M = new Function(body + "\nreturn { toGray, candidateSquares, outerCorners };")();
  self.postMessage({ type: "ready" });
}

function detect(img) {
  const cv = self.cv;
  const rgba = cv.matFromImageData(img);
  const gray = M.toGray(cv, rgba);
  try {
    const cands = M.candidateSquares(cv, gray);
    const c = M.outerCorners(cands, gray.cols);
    return { count: cands.length, corners: c ? [c.tl, c.tr, c.br, c.bl] : null };
  } finally {
    rgba.delete();
    gray.delete();
  }
}

// quad: bốn góc theo thứ tự tl, tr, br, bl (toạ độ ảnh gốc). Nới 4% từ tâm để giữ trọn mép phiếu.
function warp(img, quad) {
  const cv = self.cv;
  const cx = quad.reduce((a, p) => a + p.x, 0) / 4;
  const cy = quad.reduce((a, p) => a + p.y, 0) / 4;
  const EXPAND = 1.04;
  const [tl, tr, br, bl] = quad.map((p) => ({ x: cx + (p.x - cx) * EXPAND, y: cy + (p.y - cy) * EXPAND }));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const W = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
  const H = Math.round(Math.max(dist(tl, bl), dist(tr, br)));
  const src = cv.matFromImageData(img);
  const srcQ = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const dstQ = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
  const T = cv.getPerspectiveTransform(srcQ, dstQ);
  const dst = new cv.Mat();
  try {
    cv.warpPerspective(src, dst, T, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    return { w: W, h: H, data: new Uint8ClampedArray(dst.data) };
  } finally {
    src.delete(); srcQ.delete(); dstQ.delete(); T.delete(); dst.delete();
  }
}

self.onmessage = (e) => {
  const { id, op } = e.data;
  try {
    if (!M) throw new Error("bộ nhận diện chưa sẵn sàng");
    if (op === "detect") {
      self.postMessage({ id, ...detect(e.data.img) });
    } else if (op === "warp") {
      const r = warp(e.data.img, e.data.quad);
      self.postMessage({ id, ...r }, [r.data.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};

init().catch((err) => self.postMessage({ type: "error", text: err.message }));
