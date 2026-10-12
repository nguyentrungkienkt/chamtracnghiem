// Điều hướng và các màn hình. Logic đáp án nằm ở lib/answer-key.js.
import { sessions, sheets, newId } from "./db.js";
import { mountScan } from "./scan.js";
import { renderSheetList, renderReview } from "./review.js";
import { exportCsv, exportImages } from "./export.js";
import { fmt } from "./shared.js";
import {
  parseAnswerRows, validateStructure, maxScore, defaultScoring,
} from "../lib/answer-key.js";

const TEMPLATES = {
  ptltn2: { name: "PTLTN mẫu 2", p1Max: 40, p2Max: 8, p3Max: 6 },
  cv1239: { name: "CV1239", p1Max: 40, p2Max: 8, p3Max: 6 },
};

const view = document.getElementById("view");
const tabs = document.querySelectorAll(".tabbar button");
let state = { tab: "phien", screen: "list", draft: null, session: null };

function h(html) { view.innerHTML = html; }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setTab(tab) {
  if (stopScan) { stopScan(); stopScan = null; }
  state.tab = tab;
  state.screen = "list";
  tabs.forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  render();
}

tabs.forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

let cvPromise = null;
// Hai nguồn: thử lần lượt nếu nguồn trước không tải được.
const CV_URLS = [
  "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js",
  "https://unpkg.com/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js",
];
// Nạp OpenCV.js khi cần. onProgress(chuỗi) cập nhật trạng thái mỗi giây.
// Lỗi tải được báo ngay và chuyển sang nguồn kế tiếp; quá 150 giây thì báo lỗi.
function loadCv(onProgress = () => {}) {
  if (window.cv && window.cv.Mat) return Promise.resolve(window.cv);
  if (!cvPromise) {
    cvPromise = new Promise((resolve, reject) => {
      const t0 = Date.now();
      let done = false, state = "đang tải", idx = 0, script = null;
      const finish = (fn, v) => { if (done) return; done = true; clearInterval(timer); fn(v); };
      const fail = (msg) => { cvPromise = null; if (script) script.remove(); finish(reject, new Error(msg)); };
      const attempt = () => {
        if (script) script.remove();
        script = document.createElement("script");
        script.src = CV_URLS[idx];
        script.async = true;
        state = `đang tải từ nguồn ${idx + 1}/${CV_URLS.length}`;
        script.onload = () => { state = "đã tải xong, đang khởi tạo"; };
        script.onerror = () => {
          if (idx + 1 < CV_URLS.length) { idx++; attempt(); }
          else fail("Không tải được OpenCV.js từ mọi nguồn. Kiểm tra mạng rồi bấm Thử lại.");
        };
        document.head.appendChild(script);
      };
      const timer = setInterval(() => {
        const sec = Math.round((Date.now() - t0) / 1000);
        if (window.cv && window.cv.Mat) finish(resolve, window.cv);
        else if (sec > 150) fail("Quá 150 giây mà OpenCV.js chưa sẵn sàng. Thử lại hoặc đổi mạng.");
        else onProgress(`${state} · ${sec} giây`);
      }, 1000);
      attempt();
    });
  }
  return cvPromise;
}

// Chọn phiên khi mở tab Chấm / Bài / Xuất mà chưa có phiên đang dùng
async function withSession(render) {
  if (state.session) return render(state.session);
  let list = [];
  try { list = await sessions.all(); } catch (e) { console.warn(e); }
  if (list.length === 0) {
    h(`<h1>${TAB_TITLE[state.tab]}</h1><div class="card muted">Chưa có phiên nào. Vào tab <b>Phiên</b> để tạo phiên trước.</div>`);
    return;
  }
  h(`<h1>${TAB_TITLE[state.tab]}</h1><p class="muted">Chọn phiên:</p>
    ${list.map((x) => `<button class="card item" data-id="${esc(x.id)}"><b>${esc(x.name)}</b>
      <div class="muted">${esc(TEMPLATES[x.template]?.name || x.template)} · ${x.codes.length} mã đề</div></button>`).join("")}`);
  view.querySelectorAll("[data-id]").forEach((b) => b.onclick = async () => {
    state.session = await sessions.get(b.dataset.id);
    render(state.session);
  });
}

const TAB_TITLE = { cham: "Chấm bài", bai: "Bài đã chấm", xuat: "Xuất kết quả" };

async function render() {
  if (state.tab === "phien") {
    if (state.screen === "new") return renderNew();
    if (state.screen === "detail") return renderDetail();
    return renderList();
  }
  if (state.tab === "cham") return withSession(renderCham);
  if (state.tab === "bai") return withSession(renderBai);
  if (state.tab === "xuat") return withSession(renderXuat);
}

let stopScan = null;
function renderCham(session) {
  if (stopScan) { stopScan(); stopScan = null; }
  h(`<div class="row between"><button id="btn-pick">Đổi phiên</button><span class="muted">${esc(session.name)}</span></div><div id="scan-root"></div>`);
  document.getElementById("btn-pick").onclick = () => { state.session = null; render(); };
  const root = document.getElementById("scan-root");
  root.innerHTML = "";
  const ctl = mountScan(root, {
    loadCv, session,
    onSaved: () => {},
    onOpenReview: (id) => { stopScan && stopScan(); openReview(session, id); },
  });
  stopScan = ctl.stop;
}

function openReview(session, sheetId) {
  state.screen = "review";
  h(`<div id="rv-root"></div>`);
  renderReview(document.getElementById("rv-root"), session, sheetId, () => {
    state.tab = "bai"; state.screen = "list"; setTab("bai");
  });
}

async function renderBai(session) {
  if (stopScan) { stopScan(); stopScan = null; }
  h(`<div class="row between"><button id="btn-pick">Đổi phiên</button><span class="muted">${esc(session.name)}</span></div><div id="bai-root"></div>`);
  document.getElementById("btn-pick").onclick = () => { state.session = null; render(); };
  renderSheetList(document.getElementById("bai-root"), session, (id) => openReview(session, id));
}

function renderXuat(session) {
  if (stopScan) { stopScan(); stopScan = null; }
  h(`
    <div class="row between"><button id="btn-pick">Đổi phiên</button><span class="muted">${esc(session.name)}</span></div>
    <h1>Xuất kết quả</h1>
    <div class="card">
      <h2>Bảng điểm (CSV)</h2>
      <p class="muted">Mở được bằng Excel. Có điểm từng phần, tổng và trạng thái từng bài.</p>
      <button class="primary big" id="btn-csv">Tải bảng điểm</button>
    </div>
    <div class="card">
      <h2>Ảnh đã chấm</h2>
      <p class="muted">Gửi qua hộp chia sẻ của điện thoại, hoặc tải về từng ảnh nếu máy không hỗ trợ gửi nhiều ảnh.</p>
      <button class="big" id="btn-img">Xuất ảnh</button>
      <div id="xuat-msg" class="muted"></div>
    </div>`);
  document.getElementById("btn-pick").onclick = () => { state.session = null; render(); };
  const msg = document.getElementById("xuat-msg");
  document.getElementById("btn-csv").onclick = async () => {
    try { const n = await exportCsv(session); msg.textContent = `Đã xuất ${n} bài.`; }
    catch (e) { console.warn(e); msg.innerHTML = `<span class="err">Không xuất được bảng điểm.</span>`; }
  };
  document.getElementById("btn-img").onclick = async () => {
    try {
      const n = await exportImages(session, (i, t) => { msg.textContent = `Đang tạo ảnh ${i}/${t}…`; });
      msg.textContent = n ? `Đã xuất ${n} ảnh.` : "Không có bài nào để xuất.";
    } catch (e) { console.warn(e); msg.innerHTML = `<span class="err">Không xuất được ảnh.</span>`; }
  };
}

async function renderList() {
  let list = [];
  try { list = await sessions.all(); } catch (e) { console.warn(e); }
  h(`
    <div class="row between"><h1>Phiên chấm</h1>
      <button class="primary" id="btn-new">+ Phiên mới</button></div>
    ${list.length === 0
      ? `<div class="card muted">Chưa có phiên nào. Bấm <b>+ Phiên mới</b> để bắt đầu.</div>`
      : list.map((s) => `
        <button class="card item" data-id="${esc(s.id)}">
          <b>${esc(s.name)}</b>
          <div class="muted">${esc(TEMPLATES[s.template]?.name || s.template)} · ${s.codes.length} mã đề · tối đa ${fmt(s.maxTotal)} điểm</div>
        </button>`).join("")}
  `);
  document.getElementById("btn-new").onclick = () => { state.draft = blankDraft(); state.screen = "new"; render(); };
  view.querySelectorAll("[data-id]").forEach((b) => b.onclick = async () => {
    state.session = await sessions.get(b.dataset.id);
    state.screen = "detail";
    render();
  });
}

function blankDraft() {
  return {
    name: "",
    template: "ptltn2",
    p1Count: 12, p2Count: 2, p3Count: 4,
    scoring: defaultScoring(),
    answers: null,       // {keys, codes, errors} sau khi nhập Excel
    fileName: "",
  };
}

function renderNew() {
  const d = state.draft;
  const max = maxScore({ p1Count: d.p1Count, p2Count: d.p2Count, p3Count: d.p3Count }, d.scoring);
  const errs = validateStructure({ p1Count: d.p1Count, p2Count: d.p2Count, p3Count: d.p3Count });
  h(`
    <div class="row between"><button id="btn-back">← Quay lại</button><h1>Phiên mới</h1></div>

    <div class="card">
      <label>Tên phiên</label>
      <input id="f-name" value="${esc(d.name)}" placeholder="Ví dụ: Vật Lý 12 – Đợt 1">

      <label>Loại phiếu</label>
      <div class="seg">
        ${Object.entries(TEMPLATES).map(([k, t]) => `<button data-tpl="${k}" class="${d.template === k ? "on" : ""}">${t.name}</button>`).join("")}
      </div>
    </div>

    <div class="card">
      <h2>Phần I</h2>
      <div class="grid2">
        <div><label>Số câu</label><input id="f-p1c" type="number" inputmode="numeric" min="0" value="${d.p1Count}"></div>
        <div><label>Điểm một câu</label><input id="f-p1p" type="number" inputmode="decimal" step="0.01" min="0" value="${d.scoring.p1PerQ}"></div>
      </div>

      <h2>Phần II</h2>
      <div class="grid2">
        <div><label>Số câu</label><input id="f-p2c" type="number" inputmode="numeric" min="0" value="${d.p2Count}"></div>
        <div><label>Điểm tối đa một câu</label><input id="f-p2p" type="number" inputmode="decimal" step="0.01" min="0" value="${d.scoring.p2PerQ}"></div>
      </div>
      <label>Điểm theo số ý đúng</label>
      <div class="grid4">
        ${["1", "2", "3", "4"].map((n) => `<div><small>${n} ý</small><input data-scale="${n}" type="number" inputmode="decimal" step="0.01" min="0" value="${d.scoring.p2Scale[n]}"></div>`).join("")}
      </div>

      <h2>Phần III</h2>
      <div class="grid2">
        <div><label>Số câu</label><input id="f-p3c" type="number" inputmode="numeric" min="0" value="${d.p3Count}"></div>
        <div><label>Điểm một câu</label><input id="f-p3p" type="number" inputmode="decimal" step="0.01" min="0" value="${d.scoring.p3PerQ}"></div>
      </div>

      <div class="total">Tổng điểm tối đa: <b>${fmt(max.total)}</b> (I: ${fmt(max.p1)} · II: ${fmt(max.p2)} · III: ${fmt(max.p3)})</div>
      <div id="struct-errs">${errs.map((e) => `<div class="err">${esc(e)}</div>`).join("")}</div>
    </div>

    <div class="card">
      <h2>Đáp án</h2>
      <p class="muted">Tải file Excel theo mẫu (một dòng cho mỗi mã đề). App kiểm tra và hiện lỗi theo dòng.</p>
      <input id="f-file" type="file" accept=".xlsx,.xls,.csv">
      <div id="answers-msg"></div>
    </div>

    <button class="primary big" id="btn-save" disabled>Lưu phiên</button>
  `);

  const bind = (id, key, parse = Number) => {
    document.getElementById(id).oninput = (e) => { d[key] = parse(e.target.value); updateTotals(); };
  };
  document.getElementById("btn-back").onclick = () => { state.screen = "list"; render(); };
  document.getElementById("f-name").oninput = (e) => { d.name = e.target.value; };
  view.querySelectorAll("[data-tpl]").forEach((b) => b.onclick = () => { d.template = b.dataset.tpl; renderNew(); });
  bind("f-p1c", "p1Count", (v) => Math.floor(Number(v)));
  bind("f-p2c", "p2Count", (v) => Math.floor(Number(v)));
  bind("f-p3c", "p3Count", (v) => Math.floor(Number(v)));
  document.getElementById("f-p1p").oninput = (e) => { d.scoring.p1PerQ = Number(e.target.value); updateTotals(); };
  document.getElementById("f-p2p").oninput = (e) => { d.scoring.p2PerQ = Number(e.target.value); updateTotals(); };
  document.getElementById("f-p3p").oninput = (e) => { d.scoring.p3PerQ = Number(e.target.value); updateTotals(); };
  view.querySelectorAll("[data-scale]").forEach((el) => el.oninput = () => {
    d.scoring.p2Scale[el.dataset.scale] = Number(el.value);
    updateTotals();
  });
  document.getElementById("f-file").onchange = (e) => importFile(e.target.files[0]);
  document.getElementById("btn-save").onclick = saveDraft;
  refreshSave();
}

// Cập nhật tổng điểm, lỗi cấu trúc và nút Lưu mà không vẽ lại màn hình (để không mất con trỏ khi gõ).
function updateTotals() {
  const d = state.draft;
  const structure = { p1Count: d.p1Count, p2Count: d.p2Count, p3Count: d.p3Count };
  const max = maxScore(structure, d.scoring);
  const errs = validateStructure(structure);
  const total = view.querySelector(".total");
  if (total) total.innerHTML = `Tổng điểm tối đa: <b>${fmt(max.total)}</b> (I: ${fmt(max.p1)} · II: ${fmt(max.p2)} · III: ${fmt(max.p3)})`;
  const box = view.querySelector("#struct-errs");
  if (box) box.innerHTML = errs.map((e) => `<div class="err">${esc(e)}</div>`).join("");
  refreshSave();
}

function refreshSave() {
  const d = state.draft;
  const btn = document.getElementById("btn-save");
  if (!btn || !d) return;
  const structErrs = validateStructure({ p1Count: d.p1Count, p2Count: d.p2Count, p3Count: d.p3Count });
  const a = d.answers;
  btn.disabled = structErrs.length > 0 || !a || a.codes.length === 0 || a.errors.length > 0;
}

// Đọc file Excel bằng SheetJS (tải từ CDN, xem index.html). File CSV cũng đọc được.
async function importFile(file) {
  const msg = document.getElementById("answers-msg");
  if (!file) return;
  if (typeof XLSX === "undefined") { msg.innerHTML = `<div class="err">Chưa tải được bộ đọc Excel. Kiểm tra mạng rồi tải lại trang.</div>`; return; }
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: true });
    const d = state.draft;
    d.answers = parseAnswerRows(rows, { p1Count: d.p1Count, p2Count: d.p2Count, p3Count: d.p3Count });
    d.fileName = file.name;
    const a = d.answers;
    msg.innerHTML = `
      <div class="ok">Đã đọc <b>${esc(file.name)}</b>: ${a.codes.length} mã đề (${a.codes.map(esc).join(", ")})</div>
      ${a.errors.length ? `<div class="err"><b>${a.errors.length} lỗi, sửa file rồi chọn lại:</b><ul>${a.errors.slice(0, 30).map((e) =>
        `<li>${e.row ? `Dòng ${e.row}${e.code ? ` (mã ${esc(e.code)})` : ""}: ` : ""}${esc(e.message)}</li>`).join("")}</ul>
        ${a.errors.length > 30 ? `<div>… và ${a.errors.length - 30} lỗi khác</div>` : ""}</div>` : ""}`;
    refreshSave();
  } catch (e) {
    console.warn(e);
    msg.innerHTML = `<div class="err">Không đọc được file này. Kiểm tra đúng định dạng .xlsx.</div>`;
  }
}

async function saveDraft() {
  const d = state.draft;
  const name = d.name.trim();
  if (!name) { document.getElementById("answers-msg").insertAdjacentHTML("beforebegin", `<div class="err">Nhập tên phiên.</div>`); return; }
  const max = maxScore({ p1Count: d.p1Count, p2Count: d.p2Count, p3Count: d.p3Count }, d.scoring);
  const session = {
    id: newId(),
    name,
    template: d.template,
    structure: { p1Count: d.p1Count, p2Count: d.p2Count, p3Count: d.p3Count },
    scoring: d.scoring,
    codes: d.answers.codes,
    keys: d.answers.keys,
    maxTotal: max.total,
    answerFile: d.fileName,
    createdAt: Date.now(),
  };
  try {
    await sessions.put(session);
    state.session = session;
    state.draft = null;
    state.screen = "detail";
    render();
  } catch (e) {
    console.warn(e);
    alert("Không lưu được phiên trên máy này. Thử lại hoặc kiểm tra quyền lưu trữ của trình duyệt.");
  }
}

function renderDetail() {
  const s = state.session;
  h(`
    <div class="row between"><button id="btn-back">← Danh sách</button><button class="danger" id="btn-del">Xóa phiên</button></div>
    <h1>${esc(s.name)}</h1>
    <div class="card">
      <div>${esc(TEMPLATES[s.template]?.name || s.template)}</div>
      <div class="muted">Phần I: ${s.structure.p1Count} câu · Phần II: ${s.structure.p2Count} câu · Phần III: ${s.structure.p3Count} câu</div>
      <div class="muted">Mã đề: ${s.codes.map(esc).join(", ")}</div>
      <div class="total">Tổng điểm tối đa: <b>${fmt(s.maxTotal)}</b></div>
    </div>
    <div class="card muted">Chấm bài bằng camera sẽ có ở bước sau.</div>
  `);
  document.getElementById("btn-back").onclick = () => { state.screen = "list"; render(); };
  document.getElementById("btn-del").onclick = async () => {
    if (!confirm(`Xóa phiên "${s.name}" và toàn bộ bài đã chấm trên máy này?`)) return;
    if (!confirm("Xác nhận xóa lần nữa. Không khôi phục được.")) return;
    await sheets.removeBySession(s.id);
    await sessions.remove(s.id);
    if (state.session && state.session.id === s.id) state.session = null;
    state.screen = "list";
    render();
  };
}

// Đăng ký service worker để chạy offline. Lỗi đăng ký không ảnh hưởng đến việc dùng app.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("sw", e));
}

render();
