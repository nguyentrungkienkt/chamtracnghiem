// Ứng dụng quét phiếu trên điện thoại: tạo phiên, chọn loại phiếu, chụp ảnh, gửi lên Drive qua relay.
// Điện thoại không chấm. Việc chấm và kiểm tra làm trên máy Windows.
import { queue, newId } from "./db.js";
import { getConfig, saveConfig, clearConfig, ping, uploadBlob } from "./relay.js";

// Loại phiếu. Chỉ khai báo tên và mã; hình học và đáp án do máy Windows quản lý.
// Chỉ liệt kê phiếu tự thiết kế theo công văn 1239 (hai mẫu đang lưu hành).
// Phiên cũ có loại khác vẫn hiển thị được nhưng không chọn được nữa.
const SHEET_TYPES = {
  cv1239_bo: { name: "Mẫu bộ giáo dục" },
  cv1239_redesign: { name: "Mẫu thiết kế 1239" },
  ttk_v1: { name: "Mẫu phiếu chấm TN v1" },
};
const DEFAULT_SHEET_TYPE = "ttk_v1";

const SESSIONS_KEY = "chamtn.sessions";
const view = document.getElementById("view");
const tabs = document.querySelectorAll(".tabbar button");

const state = { tab: "phien", sessionId: null, stream: null, sending: false, detect: null };

// Thời gian giữ yên để tự chụp, thời gian nghỉ để thay phiếu, và độ dịch chuyển coi là đứng yên
const STEADY_MS = 3000;
const COOLDOWN_MS = 3000;
const DARK_MEAN = 45;     // độ sáng trung bình (0..255) dưới ngưỡng này: khung quá tối, không chụp
const MOVE_TOL = 0.03;   // dịch chuyển tối đa (theo chiều rộng khung) so với vị trí lúc bắt đầu giữ
const DETECT_W = 800;
const DETECT_TIMEOUT_MS = 8000;
const MAX_SAVE_H = 1800;   // chiều cao tối đa của ảnh lưu (px)
const SAVE_QUALITY = 0.85; // chất lượng JPEG khi lưu
const DETECT_EVERY_MS = 300;

/* ---------- phiên (lưu trên máy này) ---------- */

function loadSessions() {
  try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]"); } catch (e) { return []; }
}
function saveSessions(list) {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(list)); } catch (e) { /* bỏ qua */ }
}
function currentSession() {
  return loadSessions().find((s) => s.id === state.sessionId) || null;
}
// Tên thư mục phiên trên Drive: tên phiên + 6 ký tự đầu của id để không trùng
function sessionFolder(name, id) {
  return `${name} [${id.slice(0, 6)}]`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- gửi hàng đợi lên Drive ---------- */

const SEND_PARALLEL = 3;

// Gửi song song tối đa SEND_PARALLEL mục để giảm thời gian chờ mạng.
async function sendQueue() {
  if (state.sending || !getConfig() || !navigator.onLine) return;
  state.sending = true;
  try {
    const items = await queue.all();
    let failed = false;
    for (let i = 0; i < items.length && !failed; i += SEND_PARALLEL) {
      const batch = items.slice(i, i + SEND_PARALLEL);
      await Promise.all(batch.map(async (item) => {
        try {
          await uploadBlob(item.blob, item.name, item.mime, item.folder);
          await queue.remove(item.id);
        } catch (e) {
          console.warn(e);
          failed = true; // mất mạng hoặc lỗi relay: thử lại sau
        }
      }));
      refreshCounts();
    }
  } finally {
    state.sending = false;
    refreshCounts();
  }
}

async function refreshCounts() {
  const el = document.getElementById("pending-count");
  if (!el) return;
  try {
    const n = await queue.count();
    el.textContent = n === 0 ? "Tất cả đã gửi." : `Còn ${n} mục chờ gửi.`;
  } catch (e) { el.textContent = ""; }
}

/* ---------- màn hình ---------- */

function setTab(tab) {
  stopCamera();
  state.tab = tab;
  tabs.forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  render();
}
tabs.forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

function render() {
  if (state.tab === "phien") return renderSessions();
  if (state.tab === "quet") return renderScan();
  if (state.tab === "ket-noi") return renderConnect();
}

function renderSessions() {
  const list = loadSessions().sort((a, b) => b.createdAt - a.createdAt);
  view.innerHTML = `
    <div class="row between"><h1>Phiên chấm</h1><button class="primary" id="btn-new">+ Phiên mới</button></div>
    ${list.length === 0
      ? `<div class="card muted">Chưa có phiên nào. Bấm <b>+ Phiên mới</b> để bắt đầu.</div>`
      : list.map((s) => `
        <button class="card item" data-id="${esc(s.id)}">
          <b>${esc(s.name)}</b>
          <div class="muted">${esc(SHEET_TYPES[s.sheetType]?.name || "Loại phiếu cũ (không còn dùng)")} · ${new Date(s.createdAt).toLocaleDateString("vi-VN")}</div>
        </button>`).join("")}
    <div id="new-root"></div>`;
  document.getElementById("btn-new").onclick = () => renderNewForm();
  view.querySelectorAll("[data-id]").forEach((b) => b.onclick = () => {
    state.sessionId = b.dataset.id;
    setTab("quet");
  });
}

function renderNewForm() {
  document.getElementById("new-root").innerHTML = `
    <div class="card">
      <h2>Phiên mới</h2>
      <label>Tên phiên<input id="s-name" type="text" placeholder="Ví dụ: Toán 12A - Kiểm tra 45 phút"></label>
      <label>Loại phiếu
        <select id="s-type">
          ${Object.entries(SHEET_TYPES).map(([k, v]) => `<option value="${esc(k)}" ${k === DEFAULT_SHEET_TYPE ? "selected" : ""}>${esc(v.name)}</option>`).join("")}
        </select>
      </label>
      <div class="row"><button class="primary" id="s-save">Tạo phiên</button><button id="s-cancel">Hủy</button></div>
      <div id="s-msg" class="muted"></div>
    </div>`;
  document.getElementById("s-cancel").onclick = () => renderSessions();
  document.getElementById("s-save").onclick = async () => {
    const name = document.getElementById("s-name").value.trim();
    const sheetType = document.getElementById("s-type").value;
    if (!name) { document.getElementById("s-msg").innerHTML = `<span class="err">Nhập tên phiên.</span>`; return; }
    const id = newId();
    const session = { id, name, sheetType, createdAt: Date.now(), folder: sessionFolder(name, id) };
    saveSessions([...loadSessions(), session]);
    // Gửi file mô tả phiên lên Drive để máy Windows đồng bộ
    const json = JSON.stringify(session, null, 2);
    await queue.put({
      id: newId(), name: `phien_${session.id}.json`, mime: "application/json", folder: session.folder,
      blob: new Blob([json], { type: "application/json" }), createdAt: Date.now(),
    });
    state.sessionId = session.id;
    sendQueue();
    setTab("quet");
  };
}

function renderScan() {
  const session = currentSession();
  if (!session) {
    view.innerHTML = `<h1>Quét phiếu</h1>
      <div class="card muted">Chưa chọn phiên. Vào tab <b>Phiên</b> để tạo hoặc chọn phiên.</div>`;
    return;
  }
  view.innerHTML = `
    <div class="row between"><button id="btn-pick">Đổi phiên</button><span class="muted">${esc(session.name)}</span></div>
    <h1>Quét phiếu</h1>
    <div class="card">
      <video id="cam" autoplay playsinline muted></video>
      <p class="muted" id="cam-msg">Đang mở camera…</p>
      <button class="primary big" id="btn-shot" disabled>Chụp</button>
    </div>
    <div class="card"><div id="scan-msg" class="muted"></div><div id="pending-count" class="muted"></div></div>`;
  document.getElementById("btn-pick").onclick = () => setTab("phien");
  document.getElementById("btn-shot").onclick = () => {
    // Chụp tay: nếu vừa thấy đủ 4 ô thì cắt đúng phiếu theo 4 ô; không thì chụp toàn khung
    const q = state.detect && state.detect.lastQuad;
    if (q && Date.now() - q.t < 1500) capture(session, q.pts);
    else {
      setHint("Chưa thấy đủ 4 ô vuông, chụp toàn khung hình");
      capture(session);
    }
  };
  startCamera(session);
  refreshCounts();
}

// Chọn camera chính (1x). Camera góc rộng (0.5x) làm mép phiếu bị cong, nên tránh khi có thể.
const WIDE_RE = /ultra|wide|0\.5|tele|macro/i;

async function openCamera(deviceId) {
  const video = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  if (deviceId) video.deviceId = { exact: deviceId };
  else video.facingMode = { ideal: "environment" };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

async function startCamera(session) {
  state.scanSession = session;
  const video = document.getElementById("cam");
  const msg = document.getElementById("cam-msg");
  const btn = document.getElementById("btn-shot");
  try {
    state.stream = await openCamera();
    let track = state.stream.getVideoTracks()[0];
    // Nếu nhãn camera là góc rộng, đổi sang camera sau khác (nhãn chỉ có sau khi đã cấp quyền)
    if (WIDE_RE.test(track.label)) {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      const main = cams.find((d) => /back|rear|environment/i.test(d.label) && !WIDE_RE.test(d.label));
      if (main && main.deviceId !== track.getSettings().deviceId) {
        state.stream.getTracks().forEach((t) => t.stop());
        state.stream = await openCamera(main.deviceId);
        track = state.stream.getVideoTracks()[0];
      }
    }
    // Zoom về 1x nếu thiết bị cho phép
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.zoom) {
      const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min, 1));
      try { await track.applyConstraints({ advanced: [{ zoom: z }] }); } catch (e) { /* bỏ qua */ }
    }
    try { await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch (e) { /* không hỗ trợ */ }
    video.srcObject = state.stream;
    btn.disabled = false;
    const zoomNote = caps.zoom ? `, zoom ${caps.zoom.min}–${caps.zoom.max}` : "";
    msg.textContent = `Camera: ${track.label || "không rõ tên"}${zoomNote}. Đang nạp bộ nhận diện…`;
  } catch (e) {
    console.warn(e);
    msg.innerHTML = `<span class="err">Không mở được camera. Kiểm tra quyền camera của trình duyệt.</span>`;
    return;
  }
  startDetect(session);
}

function stopCamera() {
  stopDetect();
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
}

// Tắt màn hình hoặc chuyển app: dừng camera và bộ dò để không tự chụp khung đen/nền ngoài.
// Quay lại app: mở lại camera nếu vẫn đang ở màn hình quét.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (state.stream || state.detect) {
      stopCamera();
      const msg = document.getElementById("cam-msg");
      if (msg) msg.textContent = "Đã tạm dừng khi rời app. Quay lại app để tiếp tục quét.";
      state.resumeScan = true;
    }
  } else if (state.resumeScan && state.scanSession) {
    state.resumeScan = false;
    if (document.getElementById("cam")) startCamera(state.scanSession);
  }
});

function setHint(html) {
  const el = document.getElementById("cam-msg");
  if (el) el.innerHTML = html;
}

// Bộ nhận diện chạy trong luồng nền (js/detect-worker.js). Gửi yêu cầu, nhận kết quả theo id.
function startDetect(session) {
  stopDetect();
  const worker = new Worker("./js/detect-worker.js");
  const d = {
    worker, session, seq: 0, waiting: new Map(), ready: false, busy: false,
    timer: null, lastPts: null, since: 0, cooldownUntil: 0,
  };
  state.detect = d;
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "ready") {
      d.ready = true;
      setHint("Đưa phiếu vào khung. Khi thấy đủ 4 ô vuông và phiếu đứng yên 3 giây, app tự chụp.");
      return;
    }
    if (m.type === "error") {
      setHint(`<span class="err">Không nạp được bộ nhận diện: ${esc(m.text)}. Vẫn có thể bấm Chụp bằng tay.</span>`);
      return;
    }
    const w = d.waiting.get(m.id);
    if (!w) return;
    d.waiting.delete(m.id);
    if (m.error) w.reject(new Error(m.error)); else w.resolve(m);
  };
  worker.onerror = (e) => {
    console.warn(e);
    setHint(`<span class="err">Bộ nhận diện gặp lỗi. Vẫn có thể bấm Chụp bằng tay.</span>`);
  };
  d.timer = setInterval(() => detectTick(), DETECT_EVERY_MS);
}

function stopDetect() {
  const d = state.detect;
  if (!d) return;
  clearInterval(d.timer);
  d.worker.terminate();
  d.waiting.forEach((w) => w.reject(new Error("Đã dừng")));
  d.waiting.clear();
  state.detect = null;
}

function detectorCall(op, payload, transfer = []) {
  const d = state.detect;
  if (!d) return Promise.reject(new Error("Bộ nhận diện chưa chạy"));
  const id = ++d.seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      d.waiting.delete(id);
      reject(new Error("Xử lý quá lâu"));
    }, DETECT_TIMEOUT_MS);
    d.waiting.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    d.worker.postMessage({ id, op, ...payload }, transfer);
  });
}

// Mỗi lượt: gửi khung nhỏ cho luồng nền dò 4 ô. Nếu đủ 4 ô và không dịch chuyển trong STEADY_MS thì tự chụp.
// Sau khi chụp, nghỉ COOLDOWN_MS để người chấm thay phiếu khác.
async function detectTick() {
  const d = state.detect;
  const video = document.getElementById("cam");
  if (!d || !d.ready || d.busy || !video || !video.videoWidth) return;
  const now = Date.now();
  if (now < d.cooldownUntil) {
    setHint(`Thay phiếu khác… ${Math.ceil((d.cooldownUntil - now) / 1000)} giây`);
    return;
  }
  const w = DETECT_W;
  const h = Math.round(video.videoHeight * DETECT_W / video.videoWidth);
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const ctx = small.getContext("2d");
  ctx.drawImage(video, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 16) sum += px[i] + px[i + 1] + px[i + 2];
  const meanLight = sum / ((px.length / 16) * 3);
  if (meanLight < DARK_MEAN) {
    d.since = 0;
    d.anchor = null;
    setHint("Ánh sáng quá tối. Bật đèn hoặc đưa phiếu ra chỗ sáng hơn.");
    return;
  }
  d.busy = true;
  let res;
  try {
    res = await detectorCall("detect", { img }, [img.data.buffer]);
  } catch (e) {
    console.warn(e);
    return;
  } finally {
    d.busy = false;
  }
  if (state.detect !== d) return; // đã dừng trong lúc chờ
  if (!res.corners) {
    d.lastPts = null;
    d.anchor = null;
    d.since = 0;
    // Không hiện số ô vuông: phiếu có nhiều ô vuông bên trong (SBD, mã đề, phần III) nên con số dễ gây hiểu nhầm
    console.debug("square candidates:", res.count);
    setHint("Đưa phiếu vào khung, cần thấy đủ 4 ô vuông ở bốn góc phiếu.");
    return;
  }
  const pts = res.corners;
  const t = Date.now();
  // Lưu 4 góc theo toạ độ video để nút Chụp tay dùng đúng khi vừa thấy đủ 4 ô
  d.lastQuad = { t, pts: pts.map((p) => ({ x: p.x * video.videoWidth / w, y: p.y * video.videoHeight / h })) };
  // So với vị trí lúc bắt đầu giữ (không so với khung trước) để rung tay nhỏ không làm reset
  const ref = d.anchor;
  const moved = ref
    ? Math.max(...pts.map((p, i) => Math.hypot(p.x - ref[i].x, p.y - ref[i].y)))
    : Infinity;
  if (moved > MOVE_TOL * w || !d.since) { d.since = t; d.anchor = pts; }
  d.lastPts = pts;
  const held = t - d.since;
  if (held >= STEADY_MS) {
    d.since = 0;
    d.anchor = null;
    d.lastPts = null;
    d.cooldownUntil = t + COOLDOWN_MS;
    const full = pts.map((p) => ({ x: p.x * video.videoWidth / w, y: p.y * video.videoHeight / h }));
    setHint("Đã nhận đủ 4 ô, đang chụp…");
    capture(d.session, full);
  } else {
    setHint(`Đã thấy 4 ô. Giữ yên ${Math.ceil((STEADY_MS - held) / 1000)} giây…`);
  }
}

// Nắn phối cảnh phần trong bốn ô định vị (chạy trong luồng nền). Trả về { blob, sharp }.
async function warpToPaper(canvas, quad) {
  const img = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  const r = await detectorCall("warp", { img, quad, maxH: MAX_SAVE_H }, [img.data.buffer]);
  const out = document.createElement("canvas");
  out.width = r.w;
  out.height = r.h;
  out.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(r.data), r.w, r.h), 0, 0);
  const blob = await new Promise((resolve) => out.toBlob(resolve, "image/jpeg", SAVE_QUALITY));
  return { blob, sharp: r.sharp };
}

// Khung camera, thu nhỏ nếu quá lớn để file gửi nhanh hơn
function grabFrame(video, maxLong) {
  const k = Math.min(1, maxLong / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * k);
  canvas.height = Math.round(video.videoHeight * k);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Chụp hai khung cách nhau 300 ms rồi giữ khung nét hơn (khi có 4 ô), hoặc chụp một khung (chụp tay).
async function capture(session, quad = null) {
  const video = document.getElementById("cam");
  const msg = document.getElementById("scan-msg");
  const btn = document.getElementById("btn-shot");
  if (!video || !video.videoWidth) {
    msg.innerHTML = `<span class="err">Camera chưa sẵn sàng. Đợi hình hiện rõ rồi bấm Chụp lại.</span>`;
    return;
  }
  btn.disabled = true;
  msg.textContent = "Đang chụp…";
  try {
    let best = null;
    const shots = quad ? 2 : 1;
    for (let i = 0; i < shots; i++) {
      if (i > 0) await wait(300);
      // Khi có 4 ô, giữ nguyên độ phân giải gốc để toạ độ 4 ô khớp với khung
      const canvas = grabFrame(video, quad ? Infinity : MAX_SAVE_H);
      if (quad) {
        try {
          const r = await warpToPaper(canvas, quad);
          if (!best || r.sharp > best.sharp) best = r;
        } catch (e) { console.warn(e); }
      } else {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", SAVE_QUALITY));
        best = { blob, sharp: 0 };
      }
    }
    if (!best && quad) best = await captureFallback(video);
    if (!best || !best.blob) throw new Error("Không tạo được ảnh từ camera");
    if (document.hidden) { msg.textContent = "Đã hủy ảnh vì app đang ở nền."; return; }
    const id = newId();
    await queue.put({
      id, name: `${session.id}__${Date.now()}__${id.slice(0, 8)}.jpg`, mime: "image/jpeg",
      folder: session.folder, blob: best.blob, sessionId: session.id, createdAt: Date.now(),
    });
    const sharpNote = quad ? ` · độ nét ${Math.round(best.sharp)}` : "";
    msg.innerHTML = `<span class="ok">Đã chụp${quad ? " (đã cắt theo 4 ô" + sharpNote + ")" : ""}. Đưa phiếu tiếp theo vào khung.</span>`;
    refreshCounts();
    sendQueue();
  } catch (e) {
    console.warn(e);
    msg.innerHTML = `<span class="err">Không lưu được ảnh: ${esc(e.message || e)}. Thử lại.</span>`;
  } finally {
    btn.disabled = false;
  }
}

// Khi không nắn được phối cảnh: lưu nguyên khung camera
async function captureFallback(video) {
  const canvas = grabFrame(video, MAX_SAVE_H);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", SAVE_QUALITY));
  return { blob, sharp: 0 };
}

function renderConnect() {
  const cfg = getConfig();
  view.innerHTML = `
    <h1>Kết nối Drive</h1>
    <div class="card">
      <p class="muted">${cfg ? "Đã cài đặt kết nối. Ảnh sẽ tự gửi khi có mạng." : "Nhập địa chỉ và mã truy cập do quản trị cấp."}</p>
      <label>Địa chỉ relay<input id="r-url" type="url" value="${esc(cfg?.url || "")}" autocomplete="off"></label>
      <label>Mã truy cập<input id="r-code" type="password" value="${esc(cfg?.code || "")}" autocomplete="off"></label>
      <div class="row">
        <button class="primary" id="r-save">Lưu và kiểm tra</button>
        ${cfg ? `<button id="r-clear">Xóa kết nối</button>` : ""}
      </div>
      <div id="r-msg" class="muted"></div>
    </div>
    <div class="card">
      <h2>Gửi lại</h2>
      <button id="r-resend" ${cfg ? "" : "disabled"}>Gửi các mục đang chờ</button>
      <div id="pending-count" class="muted"></div>
    </div>`;
  const msg = document.getElementById("r-msg");
  document.getElementById("r-save").onclick = async () => {
    const url = document.getElementById("r-url").value;
    const code = document.getElementById("r-code").value;
    if (!url || !code) { msg.innerHTML = `<span class="err">Nhập đủ địa chỉ và mã.</span>`; return; }
    saveConfig(url, code);
    msg.textContent = "Đang kiểm tra…";
    try {
      const r = await ping();
      msg.innerHTML = `<span class="ok">Kết nối được. Thư mục: ${esc(r.person)}</span>`;
      sendQueue();
    } catch (e) {
      clearConfig();
      msg.innerHTML = `<span class="err">Không kết nối được: ${esc(e.message)}</span>`;
    }
  };
  const clr = document.getElementById("r-clear");
  if (clr) clr.onclick = () => { clearConfig(); renderConnect(); };
  document.getElementById("r-resend").onclick = async () => {
    msg.textContent = "Đang gửi…";
    await sendQueue();
    msg.textContent = "Xong.";
  };
  refreshCounts();
}

/* ---------- khởi động ---------- */

window.addEventListener("online", () => sendQueue());
render();
sendQueue();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((e) => console.warn(e));
}
