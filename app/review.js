// Danh sách bài đã chấm và màn kiểm tra: người chấm chọn lại các ô cần xem, rồi lưu.
// Màn kiểm tra: đầu trang là SBD và điểm (chữ lớn); vuốt trái/phải để sang bài sau/trước.
import { readItems, applyOverrides, gradeSheet, decorate, readDigits, sbdValue, BLANK, CLEAR } from "../lib/grading.js";
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

const SWIPE_MIN_PX = 60;   // quãng vuốt tối thiểu để chuyển bài
const SWIPE_MAX_MS = 700;  // vuốt chậm hơn thế là kéo, không chuyển bài

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

// SBD đọc từ phiếu (đã tính cả sửa tay); chuỗi rỗng nếu chưa đọc đủ 8 chữ số
export function sheetSbd(tpl, sheet) {
  return sbdValue(applyOverrides(readItems(tpl, sheet.darkness), sheet.overrides || {}));
}

// Danh sách bài của một phiên
export async function renderSheetList(root, session, onOpen) {
  const list = await sheets.bySession(session.id);
  const tpl = await getTemplate(session.template);
  const sbdOf = new Map(list.map((s) => [s.id, sheetSbd(tpl, s)]));
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
          <div class="row between"><b>SBD ${sbdOf.get(s.id) || "chưa đọc"} · Mã ${s.code}</b>${statusTag(s.status)}</div>
          <div class="muted">${new Date(s.createdAt).toLocaleString("vi-VN")} · Tổng ${fmt(s.total)} / ${fmt(session.maxTotal)}</div>
        </button>`).join("")}`;
    root.querySelectorAll("[data-f]").forEach((b) => b.onclick = () => { filter = b.dataset.f; draw(); });
    root.querySelectorAll("[data-id]").forEach((b) => b.onclick = () => onOpen(b.dataset.id));
  };
  draw();
}

// Màn kiểm tra một bài. onBack: quay lại danh sách; onNext: chấm phiếu tiếp theo;
// onOpen(id): mở bài khác (vuốt trái = bài sau trong danh sách, vuốt phải = bài trước).
export async function renderReview(root, session, sheetId, onBack, onNext = () => {}, onOpen = () => {}) {
  const original = await sheets.get(sheetId);
  if (!original) { root.innerHTML = `<div class="err">Không tìm thấy bài này.</div>`; return; }
  const sheet = { ...original, overrides: { ...(original.overrides || {}) } };
  const tpl = await getTemplate(session.template);
  const order = (await sheets.bySession(session.id)).map((s) => s.id);   // cùng thứ tự với danh sách
  const pos = order.indexOf(sheet.id);

  // Tính lại toàn bộ từ độ đen gốc + các sửa tay
  function recompute() {
    const read = applyOverrides(readItems(tpl, sheet.darkness), sheet.overrides);
    const keys = findKeys(session.keys, sheet.code) || {};
    const warnings = [];
    if (!findKeys(session.keys, sheet.code)) warnings.push(`Mã đề ${sheet.code} chưa có đáp án`);
    const cr = readDigits(read, "code", 4);
    if (!cr.ok) {
      // Chẩn đoán: độ đen cao nhất và thứ nhì của từng chữ số mã đề
      const detail = cr.unread.map((i) => {
        const r = read[`code:${i}`];
        if (!r || !r.scores) return `vị trí ${i}: không có dữ liệu`;
        const sc = [...r.scores].sort((a, b) => b - a);
        return `vị trí ${i}: ${sc[0].toFixed(2)}/${sc[1].toFixed(2)}`;
      }).join("; ");
      warnings.push(`Mã đề trên phiếu chưa đọc đủ (độ đen cao/thứ nhì: ${detail})`);
    }
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
    // SBD không chặn việc chấm: chưa đọc đủ thì chỉ hiện ô để sửa
    const sbd = sbdValue(read);
    const sbdPending = sbd ? [] : Object.keys(read).filter((k) => k.startsWith("sbd:") && read[k].status !== CLEAR);
    const status = grade && uniq.length === 0 && warnings.length === 0 ? "GRADED" : "NEEDS_REVIEW";
    sheet.warnings = warnings;
    sheet.status = status;
    sheet.parts = grade ? grade.parts : { p1: 0, p2: 0, p3: 0 };
    sheet.total = grade ? grade.total : 0;
    return { read, keys, grade, pending: uniq, sbd, sbdPending, warnings, status };
  }

  let current = recompute();
  const eff = (k) => (k in sheet.overrides ? sheet.overrides[k] : (current.read[k].status === CLEAR ? current.read[k].suggestion : ""));
  const cycleOf = (k) => CYCLE[current.read[k]?.kind || "option"];

  let showGrid = false;

  // Độ đen cao nhất và thứ nhì của một ô, để biết vì sao ô bị đánh dấu cần xem
  const darkDiag = (k) => {
    const r = current.read[k];
    if (!r || !r.scores) return "không có";
    const sc = [...r.scores].sort((a, b) => b - a);
    return `${sc[0].toFixed(2)}/${(sc[1] ?? 0).toFixed(2)}`;
  };

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
      scoreLines: scoreLines({ ...sheet, sbd: current.sbd }, session), grid: showGrid,
    });
    canvas.style.width = "100%";
    canvas.style.height = "auto";
    root.querySelector("#rv-img")?.replaceChildren(canvas);
  }

  function layout() {
    const p = sheet.parts;
    root.innerHTML = `
      <div class="row between"><button id="rv-back">← Danh sách</button><button class="danger" id="rv-del">Xóa bài</button></div>
      <div class="card scorecard">
        <div class="sbd">SBD <b>${current.sbd || "chưa đọc"}</b></div>
        <div class="bigtotal"><b>${fmt(sheet.total)}</b><span> / ${fmt(session.maxTotal)}</span></div>
        <div class="parts">Phần I ${fmt(p.p1)} · Phần II ${fmt(p.p2)} · Phần III ${fmt(p.p3)}</div>
        <div class="row between">
          <span>Mã đề <select id="rv-code">${session.codes.map((c) => `<option value="${c}" ${c === sheet.code ? "selected" : ""}>${c}</option>`).join("")}</select></span>
          ${statusTag(sheet.status)}
        </div>
        ${current.warnings.map((w) => `<div class="err">${w}</div>`).join("")}
      </div>
      <div id="rv-img" class="imgbox"></div>
      <p class="navhint">${pos >= 0 ? `Bài ${pos + 1} / ${order.length} · ` : ""}Vuốt trái: bài sau · vuốt phải: bài trước</p>
      <div class="row">
        <button id="rv-prev" ${pos <= 0 ? "disabled" : ""}>‹ Bài trước</button>
        <button id="rv-following" ${pos < 0 || pos >= order.length - 1 ? "disabled" : ""}>Bài sau ›</button>
      </div>
      <div class="row"><button id="rv-grid">${showGrid ? "Ẩn lưới ô" : "Hiện lưới ô (kiểm tra căn chỉnh)"}</button><button id="rv-rot">Xoay 180°</button><button id="rv-reread">Đọc lại</button></div>
      <button class="primary big" id="rv-next">Chấm phiếu tiếp theo</button>
      ${current.pending.length ? `
        <div class="card">
          <h2>Cần xem (${current.pending.length} ô)</h2>
          <p class="muted">Chạm vào ô để đổi đáp án: xoay vòng qua các lựa chọn và trống.</p>
          ${current.pending.map((k) => `
            <button class="row between pick" data-k="${k}">
              <span>${itemName(k)}<br><small class="muted">độ đen cao/nhì: ${darkDiag(k)}</small></span><b>${eff(k) || "trống"}</b>
            </button>`).join("")}
        </div>` : `<div class="card ok">Không còn ô cần xem.</div>`}
      ${current.sbdPending.length ? `
        <div class="card">
          <h2>Số báo danh chưa đọc đủ</h2>
          <p class="muted">Không ảnh hưởng đến điểm. Chạm vào ô để sửa chữ số.</p>
          ${current.sbdPending.map((k) => `
            <button class="row between pick" data-k="${k}">
              <span>${itemName(k)}<br><small class="muted">độ đen cao/nhì: ${darkDiag(k)}</small></span><b>${eff(k) || "trống"}</b>
            </button>`).join("")}
        </div>` : ""}
      <button class="primary big" id="rv-save">Lưu</button>
    `;
    root.querySelector("#rv-back").onclick = onBack;
    root.querySelector("#rv-grid").onclick = () => { showGrid = !showGrid; layout(); paint(); };
    root.querySelector("#rv-next").onclick = onNext;
    root.querySelector("#rv-prev").onclick = () => move(-1);
    root.querySelector("#rv-following").onclick = () => move(1);
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

  // Ghi bài xuống máy (dùng cho nút Lưu và khi chuyển bài)
  async function persist() {
    const { darkness, alignedBlob, photoBlob, id, sessionId, createdAt, k } = sheet;
    await sheets.put({
      id, sessionId, createdAt, darkness, alignedBlob, photoBlob, k,
      code: sheet.code, overrides: sheet.overrides, warnings: sheet.warnings,
      status: sheet.status, parts: sheet.parts, total: sheet.total,
    });
  }

  async function save() {
    try {
      await persist();
      const btn = root.querySelector("#rv-save");
      btn.textContent = "Đã lưu";
      setTimeout(() => { if (btn) btn.textContent = "Lưu"; }, 1500);
    } catch (e) {
      console.warn(e);
      alert("Không lưu được bài. Thử lại.");
    }
  }

  // Chuyển sang bài kế bên: lưu bài hiện tại trước để không mất sửa tay
  async function move(delta) {
    const target = order[pos + delta];
    if (!target) return;
    try { await persist(); } catch (e) { console.warn(e); alert("Không lưu được bài hiện tại. Chưa chuyển bài."); return; }
    onOpen(target);
  }

  // Vuốt: chạm đầu và chạm cuối, lệch ngang đủ lớn và nhanh thì chuyển bài
  let touch = null;
  root.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { touch = null; return; }
    const t = e.touches[0];
    touch = { x: t.clientX, y: t.clientY, t: Date.now() };
  }, { passive: true });
  root.addEventListener("touchend", (e) => {
    if (!touch) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x, dy = t.clientY - touch.y, dt = Date.now() - touch.t;
    touch = null;
    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > 1.5 * Math.abs(dy) && dt < SWIPE_MAX_MS) move(dx < 0 ? 1 : -1);
  }, { passive: true });

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
  const s = { ...sheet, sbd: sbdValue(read), parts: grade ? grade.parts : sheet.parts, total: grade ? grade.total : sheet.total };
  const canvas = await drawGraded({ tpl, alignedBlob: sheet.alignedBlob, decorations: decos, scoreLines: scoreLines(s, session) });
  return canvasToBlob(canvas, 0.85);
}
