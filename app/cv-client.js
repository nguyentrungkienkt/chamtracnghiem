// Cầu nối từ giao diện tới luồng nền xử lý ảnh (cv-worker.js).
// Giao diện chỉ gửi điểm ảnh và nhận kết quả; mọi việc nặng chạy trong luồng nền.

const INIT_TIMEOUT_S = 150;

let worker = null;
let initPromise = null;
let seq = 0;
const waiting = new Map();

function call(op, payload = {}, transfer = []) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, op, ...payload }, transfer);
  });
}

// Nạp OpenCV.js trong luồng nền. onProgress(chuỗi) được gọi mỗi giây để hiện trạng thái.
export function ensureCv(onProgress = () => {}) {
  if (initPromise) return initPromise;
  initPromise = new Promise((resolve, reject) => {
    const t0 = Date.now();
    let text = "đang tải";
    let tick = null;
    const fail = (msg) => {
      clearInterval(tick);
      if (worker) worker.terminate();
      worker = null;
      initPromise = null;
      reject(new Error(msg));
    };
    tick = setInterval(() => {
      const sec = Math.round((Date.now() - t0) / 1000);
      if (sec > INIT_TIMEOUT_S) return fail(`Quá ${INIT_TIMEOUT_S} giây mà OpenCV.js chưa sẵn sàng. Thử lại hoặc đổi mạng.`);
      onProgress(`${text} · ${sec} giây`);
    }, 1000);

    worker = new Worker("./app/cv-worker.js");
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "status") { text = m.text; return; }
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.ok) w.resolve(m.result);
      else {
        const err = new Error(m.error.message);
        err.name = m.error.name;
        w.reject(err);
      }
    };
    worker.onerror = (e) => fail(`Lỗi trong bộ xử lý ảnh: ${e.message || "không rõ nguyên nhân"}`);
    call("init").then(
      () => { clearInterval(tick); resolve(); },
      (err) => fail(err.message),
    );
  });
  return initPromise;
}

// img: ImageData từ canvas (kích thước xem trước). Trả về {quality, corners}.
export function analyseFrame(img) {
  const data = img.data.slice();
  return call("frame", { buf: data.buffer, w: img.width, h: img.height }, [data.buffer]);
}

// img: ImageData của cả khung chụp; tpl: mẫu phiếu. Trả về {data, w, h, darkness, k}.
export function processPhoto(img, tpl, k = null) {
  const data = img.data.slice();
  return call("photo", { buf: data.buffer, w: img.width, h: img.height, tpl, k }, [data.buffer]);
}
