// Danh sách bài đã chấm và màn kiểm tra: người chấm chọn lại các ô cần xem, rồi lưu.
import { readItems, applyOverrides, gradeSheet, decorate, readDigits, BLANK, CLEAR } from "../lib/grading.js";
import { findKeys } from "../lib/answer-key.js";
import { drawGraded, canvasToBlob, blobToImage, grayToCanvas } from "./render.js";
import { ensureCv, processPhoto } from "./cv-client.js";
import { sheets } from "./db.js";
import { getTemplate } from "./templates.js";
import { fmt, scoreLines } from "./shared.js";

// Các giá trị có thể chọn cho từng loại ô, theo thứ tự xoay vòng
const CYCLE = {
  option: ["A", "B", "C", "D", ""],
  tf: ["Đ", "S", ""],
  symbol: ["-", ",", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ""],
  digit: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ""],
};

const statusTag = (s) => (s === "GRADED" ? `<span class="tag ok">Đã chấm</span>` : `<span class="tag warn">Cần xem</span>`);

function itemName(key) {
  const p = key.split(":");
  if (p[0] === "p1") return `Phần I, câu ${p[1]}`;
  if (p[0] === "p2") return `Phần II, câu ${p[1]} ý ${p[2]}`;
  if (p[0] === "p3") return `Phần III, câu ${p[1]} cột ${p[2]}`;
  if (p[0] === "sbd") return `Số báo danh, chữ số ${p[1]}`;
  if (p[0] === "code") return `Mã đề, chữ số ${p[1]}`;
  return key;
}

// Danh sách bài của một phiên
export async function renderSheetList(root, session, onOpen) {
  const list = await sheets.bySession(session.id);
  let filter = "all";
  const draw = () => {
    const rows = list.filter((s) => filter === "all" || s.status !== "GRADED");
    root.innerHTML = `
      <h1>Bài đã chấm</h1>
      <div class="seg">
        <button data-f="all" class="${filter === "all" ? "on" : ""}">Tất cả (${list.length})</button>
        <button data-f="review" class="${filter === "review" ? "on" : ""}">Cần xem (${list.filter((s) => s.status !== "GRADED").length})</button>
      </div>
      ${rows.length === 0 ? `<div class="card muted">Chưa có bài nào.</div>` : rows.map((s) => `
        <button class="card item" data-id="${s.id}">
          <div class="row between"><b>Mã ${s.code}</b>${statusTag(s.status)}</div>
          <div class="muted">${new Date(s.createdAt).toLocaleString("vi-VN")} · Tổng ${fmt(s.total)} / ${fmt(session.maxTotal)}</div>
        </button>`).join("")}`;
    root.querySelectorAll("[data-f]").forEach((b) => b.onclick = () => { filter = b.dataset.f; draw(); });
    root.querySelectorAll("[data-id]").forEach((b) => b.onclick = () => onOpen(b.dataset.id));
  };
  draw();
}

// Màn kiểm tra một bài. onBack: quay lại danh sách.
export async function renderReview(root, session, sheetId, onBack, onNext = () => {}) {
  const original = await sheets.get(sheetId);
  if (!original) { root.innerHTML = `<div class="err">Không tìm thấy bài này.</div>`; return; }
  const sheet = { ...original, overrides: { ...(original.overrides || {}) } };
  const tpl = await getTemplate(session.template);

  // Tính lại toàn bộ từ độ đen gốc + các sửa tay
  function recompute() {
    const read = applyOverrides(readItems(tpl, sheet.darkness), sheet.overrides);
    const keys = findKeys(session.keys, sheet.code) || {};
    const warnings = [];
    if (!findKeys(session.keys, sheet.code)) warnings.push(`Mã đề ${sheet.code} chưa có đáp án`);
    const cr = readDigits(read, "code", 4);
    if (!cr.ok) warnings.push("Mã đề trên phiếu chưa đọc đủ");
    else if (cr.value !== sheet.code) warnings.push(`Mã đề trên phiếu là ${cr.value}, khác mã đang chọn ${sheet.code}`);
    const grade = findKeys(session.keys, sheet.code) ? gradeSheet(read, keys, session.structure, session.scoring) : null;
    const pending = [];
    if (grade) {
      for (const p of grade.pending) {
        if (p.item in read) pending.push(p.item);
        else for (let i = 1; i <= 4; i++) pending.push(`p3:${p.question}:${i}`);   // ô trống giữa câu: cho sửa cả câu
      }
      for (const d of grade.digitFlags) pending.push(d);
    } else {
      for (const k of Object.keys(read)) if (read[k].kind === "digit" && read[k].status !== CLEAR && !k.startsWith("sbd:")) pending.push(k);
    }
    const uniq = [...new Set(pending)];
    const status = grade && uniq.length === 0 && warnings.length === 0 ? "GRADED" : "NEEDS_REVIEW";
    sheet.warnings = warnings;
    sheet.status = status;
    sheet.parts = grade ? grade.parts : { p1: 0, p2: 0, p3: 0 };
    sheet.total = grade ? grade.total : 0;
    return { read, keys, grade, pending: uniq, warnings, status };
  }

  let current = recompute();
  const eff = (k) => (k in sheet.overrides ? sheet.overrides[k] : (current.read[k].status === CLEAR ? current.read[k].suggestion : ""));
  const cycleOf = (k) => CYCLE[current.read[k]?.kind || "option"];

  let showGrid = false;

  // Phiếu bị ngược: xử lý lại từ ảnh chụp gốc với chiều đã đổi 180 độ, rồi chấm lại.
  async function rotate180() { await reprocess(((sheet.k ?? 0) + 2) % 4, "#rv-rot", "Xoay 180°"); }

  // Đọc lại từ ảnh chụp gốc với mẫu hiện tại (dùng sau khi cập nhật mẫu). k: chiều phiếu, null = tự dò.
  async function reprocess(k, btnSel, btnText) {
    const btn = root.querySelector(btnSel);
    if (!sheet.photoBlob) { alert("Bài này không còn ảnh chụp gốc để xử lý lại."); return; }
    btn.disabled = true; btn.textContent = "Đang xử lý…";
    try {
      await ensureCv();
      const img = await blobToImage(sheet.photoBlob);
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      const res = await processPhoto(c.getContext("2d").getImageData(0, 0, c.width, c.height), tpl, k);
      sheet.alignedBlob = await canvasToBlob(grayToCanvas(res.data, res.w, res.h), 0.9);
      sheet.darkness = res.darkness;
      sheet.k = res.k;
      sheet.overrides = {};
      await sheets.put(sheet);
      current = recompute();
      layout(); paint();
    } catch (e) {
      alert(`Không xử lý lại được phiếu: ${e.message}`);
      btn.disabled = false; btn.textContent = btnText;
    }
  }
  async function paint() {
    const decos = current.grade ? decorate(tpl, current.read, current.keys, session.structure) : [];
    const canvas = await drawGraded({
      tpl, alignedBlob: sheet.alignedBlob, decorations: decos,
      scoreLines: scoreLines(sheet, session), grid: showGrid,
    });
    canvas.style.width = "100%";
    canvas.style.height = "auto";
    root.querySelector("#rv-img").replaceChildren(canvas);
  }

  function layout() {
    root.innerHTML = `
      <div class="row between"><button id="rv-back">← Danh sách</button><button class="danger" id="rv-del">Xóa bài</button></div>
      <h1>Bài mã ${sheet.code} ${statusTag(sheet.status)}</h1>
      <div id="rv-img" class="imgbox"></div>
      <div class="row"><button id="rv-grid">${showGrid ? "Ẩn lưới ô" : "Hiện lưới ô (kiểm tra căn chỉnh)"}</button><button id="rv-rot">Xoay 180°</button><button id="rv-reread">Đọc lại</button></div>
      <button class="primary big" id="rv-next">Chấm phiếu tiếp theo</button>
      <div class="card">
        <div class="total">Tổng: <b>${fmt(sheet.total)}</b> / ${fmt(session.maxTotal)}</div>
        ${current.warnings.map((w) => `<div class="err">${w}</div>`).join("")}
        <label>Mã đề của bài</label>
        <select id="rv-code">${session.codes.map((c) => `<option value="${c}" ${c === sheet.code ? "selected" : ""}>${c}</option>`).join("")}</select>
      </div>
      ${current.pending.length ? `
        <div class="card">
          <h2>Cần xem (${current.pending.length} ô)</h2>
          <p class="muted">Chạm vào ô để đổi đáp án: xoay vòng qua các lựa chọn và trống.</p>
          ${current.pending.map((k) => `
            <button class="row between pick" data-k="${k}">
              <span>${itemName(k)}</span><b>${eff(k) || "trống"}</b>
            </button>`).join("")}
        </div>` : `<div class="card ok">Không còn ô cần xem.</div>`}
      <button class="primary big" id="rv-save">Lưu</button>
    `;
    root.querySelector("#rv-back").onclick = onBack;
    root.querySelector("#rv-grid").onclick = () => { showGrid = !showGrid; layout(); paint(); };
    root.querySelector("#rv-next").onclick = onNext;
    root.querySelector("#rv-rot").onclick = rotate180;
    root.querySelector("#rv-reread").onclick = () => reprocess(sheet.k ?? null, "#rv-reread", "Đọc lại");
    root.querySelector("#rv-code").onchange = (e) => { sheet.code = e.target.value; refresh(); };
    root.querySelectorAll("[data-k]").forEach((b) => b.onclick = () => {
      const k = b.dataset.k;
      const list = cycleOf(k);
      const cur = eff(k);
      const next = list[(list.indexOf(cur) + 1) % list.length];
      sheet.overrides[k] = next;
      refresh();
    });
    root.querySelector("#rv-save").onclick = save;
    root.querySelector("#rv-del").onclick = async () => {
      if (!confirm("Xóa bài này?")) return;
      await sheets.remove(sheet.id);
      onBack();
    };
  }

  function refresh() {
    current = recompute();
    layout();
    paint();
  }

  async function save() {
    try {
      const { darkness, alignedBlob, photoBlob, id, sessionId, createdAt } = sheet;
      await sheets.put({
        id, sessionId, createdAt, darkness, alignedBlob, photoBlob,
        code: sheet.code, overrides: sheet.overrides, warnings: sheet.warnings,
        status: sheet.status, parts: sheet.parts, total: sheet.total,
      });
      const btn = root.querySelector("#rv-save");
      btn.textContent = "Đã lưu";
      setTimeout(() => { if (btn) btn.textContent = "Lưu"; }, 1500);
    } catch (e) {
      console.warn(e);
      alert("Không lưu được bài. Thử lại.");
    }
  }

  layout();
  paint();
}

// Ảnh đã chấm của một bài (dùng cho xuất ảnh)
export async function gradedBlob(session, sheet) {
  const tpl = await getTemplate(session.template);
  const read = applyOverrides(readItems(tpl, sheet.darkness), sheet.overrides || {});
  const keys = findKeys(session.keys, sheet.code) || {};
  const grade = findKeys(session.keys, sheet.code) ? gradeSheet(read, keys, session.structure, session.scoring) : null;
  const decos = grade ? decorate(tpl, read, keys, session.structure) : [];
  const s = { ...sheet, parts: grade ? grade.parts : sheet.parts, total: grade ? grade.total : sheet.total };
  const canvas = await drawGraded({ tpl, alignedBlob: sheet.alignedBlob, decorations: decos, scoreLines: scoreLines(s, session) });
  return canvasToBlob(canvas, 0.85);
}
