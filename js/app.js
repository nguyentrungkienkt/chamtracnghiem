// Ứng dụng quét phiếu trên điện thoại: tạo phiên, chọn loại phiếu, chụp ảnh, gửi lên Drive qua relay.
// Điện thoại không chấm. Việc chấm và kiểm tra làm trên máy Windows.
import { queue, newId } from "./db.js";
import { getConfig, saveConfig, clearConfig, ping, uploadBlob } from "./relay.js";
import { candidateSquares, outerCorners, toGray } from "./corners.js";

// Loại phiếu. Chỉ khai báo tên và mã; hình học và đáp án do máy Windows quản lý.
const SHEET_TYPES = {
  ptltn2: { name: "Phiếu quét 300 dpi (mẫu 2)" },
};

const SESSIONS_KEY = "chamtn.sessions";
const view = document.getElementById("view");
const tabs = document.querySelectorAll(".tabbar button");

const state = { tab: "phien", sessionId: null, stream: null, sending: false, detect: null };

// Thời gian giữ yên để tự chụp, thời gian nghỉ để thay phiếu, và độ dịch chuyển coi là đứng yên
const STEADY_MS = 3000;
const COOLDOWN_MS = 3000;
const MOVE_TOL = 0.01;
const DETECT_W = 640;
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
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- gửi hàng đợi lên Drive ---------- */

async function sendQueue() {
  if (state.sending || !getConfig() || !navigator.onLine) return;
  state.sending = true;
  try {
    const items = await queue.all();
    for (const item of items) {
      try {
        await uploadBlob(item.blob, item.name, item.mime);
        await queue.remove(item.id);
      } catch (e) {
        console.warn(e);
        break; // mất mạng hoặc lỗi relay: thử lại sau
      }
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
          <div class="muted">${esc(SHEET_TYPES[s.sheetType]?.name || s.sheetType)} · ${new Date(s.createdAt).toLocaleDateString("vi-VN")}</div>
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
          ${Object.entries(SHEET_TYPES).map(([k, v]) => `<option value="${esc(k)}">${esc(v.name)}</option>`).join("")}
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
    const session = { id: newId(), name, sheetType, createdAt: Date.now() };
    saveSessions([...loadSessions(), session]);
    // Gửi file mô tả phiên lên Drive để máy Windows đồng bộ
    const json = JSON.stringify(session, null, 2);
    await queue.put({
      id: newId(), name: `phien_${session.id}.json`, mime: "application/json",
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
  document.getElementById("btn-shot").onclick = () => capture(session);
  startCamera(session);
  refreshCounts();
}

let cvPromise = null;
// Nạp OpenCV.js trên trang để dò 4 ô vuông. File khoảng 10 MB, chỉ nạp một lần.
function loadOpenCv() {
  if (!cvPromise) {
    cvPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js";
      s.async = true;
      s.onload = () => {
        const t = setInterval(() => {
          if (window.cv && window.cv.Mat) { clearInterval(t); resolve(window.cv); }
        }, 100);
      };
      s.onerror = () => { cvPromise = null; reject(new Error("Không tải được OpenCV.js")); };
      document.head.appendChild(s);
    });
  }
  return cvPromise;
}

async function startCamera(session) {
  const video = document.getElementById("cam");
  const msg = document.getElementById("cam-msg");
  const btn = document.getElementById("btn-shot");
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = state.stream;
    btn.disabled = false;
  } catch (e) {
    console.warn(e);
    msg.innerHTML = `<span class="err">Không mở được camera. Kiểm tra quyền camera của trình duyệt.</span>`;
    return;
  }
  msg.textContent = "Đang nạp bộ nhận diện… Bấm Chụp nếu cần chụp tay.";
  try {
    await loadOpenCv();
    msg.textContent = "Đưa phiếu vào khung. Khi thấy đủ 4 ô vuông và phiếu đứng yên 3 giây, app tự chụp.";
    startDetect(session);
  } catch (e) {
    console.warn(e);
    msg.innerHTML = `<span class="err">Không nạp được bộ nhận diện: ${esc(e.message)}. Vẫn có thể bấm Chụp bằng tay.</span>`;
  }
}

function stopCamera() {
  stopDetect();
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
}

function startDetect(session) {
  stopDetect();
  state.detect = { timer: null, lastPts: null, since: 0, cooldownUntil: 0, busy: false };
  state.detect.timer = setInterval(() => detectTick(session), DETECT_EVERY_MS);
}

function stopDetect() {
  if (state.detect && state.detect.timer) clearInterval(state.detect.timer);
  state.detect = null;
}

// Mỗi lượt: dò 4 ô vuông trên khung hình nhỏ. Nếu đủ 4 ô và không dịch chuyển trong STEADY_MS thì tự chụp.
// Sau khi chụp, nghỉ COOLDOWN_MS để người chấm thay phiếu khác.
function detectTick(session) {
  const d = state.detect;
  const video = document.getElementById("cam");
  const hint = document.getElementById("cam-msg");
  if (!d || !video || !video.videoWidth || d.busy || !window.cv) return;
  const now = Date.now();
  if (now < d.cooldownUntil) {
    hint.textContent = `Thay phiếu khác… ${Math.ceil((d.cooldownUntil - now) / 1000)} giây`;
    return;
  }
  const cv = window.cv;
  const w = DETECT_W;
  const h = Math.round(video.videoHeight * DETECT_W / video.videoWidth);
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  small.getContext("2d").drawImage(video, 0, 0, w, h);
  let rgba = null, gray = null;
  try {
    rgba = cv.imread(small);
    gray = toGray(cv, rgba);
    const corners = outerCorners(candidateSquares(cv, gray), gray.cols);
    if (!corners) {
      d.lastPts = null;
      d.since = 0;
      hint.textContent = "Đưa phiếu vào khung, cần thấy đủ 4 ô vuông.";
      return;
    }
    const pts = [corners.tl, corners.tr, corners.br, corners.bl];
    const moved = d.lastPts
      ? Math.max(...pts.map((p, i) => Math.hypot(p.x - d.lastPts[i].x, p.y - d.lastPts[i].y)))
      : Infinity;
    if (moved > MOVE_TOL * w || !d.since) d.since = now;
    d.lastPts = pts;
    const held = now - d.since;
    if (held >= STEADY_MS) {
      d.busy = true;
      d.since = 0;
      d.lastPts = null;
      d.cooldownUntil = now + COOLDOWN_MS;
      hint.textContent = "Đã nhận đủ 4 ô, đang chụp…";
      capture(session).finally(() => { d.busy = false; });
    } else {
      hint.textContent = `Đã thấy 4 ô. Giữ yên ${Math.ceil((STEADY_MS - held) / 1000)} giây…`;
    }
  } catch (e) {
    console.warn(e);
  } finally {
    if (rgba) rgba.delete();
    if (gray) gray.delete();
  }
}

async function capture(session) {
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
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) throw new Error("Không tạo được ảnh từ camera");
    const id = newId();
    await queue.put({
      id, name: `${session.id}__${Date.now()}__${id.slice(0, 8)}.jpg`, mime: "image/jpeg",
      blob, sessionId: session.id, createdAt: Date.now(),
    });
    msg.innerHTML = `<span class="ok">Đã chụp. Đưa phiếu tiếp theo vào khung.</span>`;
    refreshCounts();
    sendQueue();
  } catch (e) {
    console.warn(e);
    msg.innerHTML = `<span class="err">Không lưu được ảnh: ${esc(e.message || e)}. Thử lại.</span>`;
  } finally {
    btn.disabled = false;
  }
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
