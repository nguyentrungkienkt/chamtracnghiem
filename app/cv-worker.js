// Luồng nền xử lý ảnh: nạp OpenCV.js và chạy thuật toán dò góc, căn chỉnh, đọc ô.
// Chạy riêng để giao diện không bị đứng khi nạp file ~10 MB trên điện thoại.
// Đây là Worker kiểu cổ điển (không dùng import), nên omr.js được đọc và chạy trong hàm riêng.

const CV_SOURCES = [
  "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js",
  "https://unpkg.com/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js",
];

let M = null;   // các hàm của omr.js

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

async function init() {
  let ok = false;
  for (let i = 0; i < CV_SOURCES.length && !ok; i++) {
    post({ type: "status", text: `đang tải từ nguồn ${i + 1}/${CV_SOURCES.length}` });
    try { importScripts(CV_SOURCES[i]); ok = true; } catch (e) { /* thử nguồn kế tiếp */ }
  }
  if (!ok) throw new Error("Không tải được OpenCV.js từ mọi nguồn. Kiểm tra mạng rồi bấm Thử lại.");
  post({ type: "status", text: "đã tải xong, đang khởi tạo" });
  while (!(self.cv && self.cv.Mat)) await new Promise((r) => setTimeout(r, 100));

  // omr.js dùng cú pháp export; bỏ từ khoá export rồi gói trong hàm để lấy các hàm cần dùng.
  const src = await (await fetch(new URL("./omr.js", self.location.href))).text();
  const body = src.replace(/^export\s+/gm, "");
  M = new Function(body + "\nreturn { toGray, candidateSquares, outerCorners, frameQuality, processPhoto, QUALITY, AlignError };")();
}

// Tạo Mat RGBA từ mảng điểm ảnh thô (không dùng ImageData, để chạy được trên mọi trình duyệt).
function matFromPixels(buf, w, h) {
  const mat = new self.cv.Mat(h, w, self.cv.CV_8UC4);
  mat.data.set(new Uint8Array(buf));
  return mat;
}

self.onmessage = async (e) => {
  const { id, op } = e.data;
  const cv = self.cv;
  try {
    if (op === "init") {
      await init();
      post({ id, ok: true });
      return;
    }
    if (op === "frame") {
      const rgba = matFromPixels(e.data.buf, e.data.w, e.data.h);
      const gray = M.toGray(cv, rgba);
      rgba.delete();
      try {
        const quality = M.frameQuality(gray);
        const corners = M.outerCorners(M.candidateSquares(cv, gray));
        post({ id, ok: true, result: { quality, corners } });
      } finally {
        gray.delete();
      }
      return;
    }
    if (op === "photo") {
      const rgba = matFromPixels(e.data.buf, e.data.w, e.data.h);
      const gray = M.toGray(cv, rgba);
      rgba.delete();
      let res;
      try {
        res = M.processPhoto(cv, gray, e.data.tpl, e.data.k ?? null);
      } finally {
        gray.delete();
      }
      const w = res.aligned.cols, h = res.aligned.rows;
      const data = new Uint8Array(res.aligned.data);   // bản sao, tách khỏi bộ nhớ wasm
      res.aligned.delete();
      post({ id, ok: true, result: { data, w, h, darkness: res.darkness, k: res.k, marks: res.marks, dev: res.dev, residual: res.residual } }, [data.buffer]);
      return;
    }
    throw new Error(`Thao tác không hỗ trợ: ${op}`);
  } catch (err) {
    post({ id, ok: false, error: { name: err.name || "Error", message: err.message || String(err) } });
  }
};
