// Màn chấm bằng camera: xem trước, dò 4 góc, tự chụp khi phiếu đứng yên, rồi chấm.
import { QUALITY } from "./omr.js";
import { ensureCv, analyseFrame, processPhoto } from "./cv-client.js";
import { readItems, gradeSheet, decorate, readDigits } from "../lib/grading.js";
import { grayToCanvas, canvasToBlob, drawGraded } from "./render.js";
import { sheets, newId } from "./db.js";
import { getTemplate } from "./templates.js";
import { fmt } from "./shared.js";

const PREVIEW_W = 480;        // ảnh xem trước để dò góc nhanh
const STABLE_MS = 3000;       // phiếu đứng yên bao lâu thì tự chụp
const MOVE_PX = 8;            // dịch chuyển góc tối đa (px, trên ảnh xem trước) vẫn tính là đứng yên
const TICK_MS = 200;          // chu kỳ phân tích khung hình

export function mountScan(root, { session, onSaved, onOpenReview }) {
  let stream = null, timer = null, busy = false, analysing = false, lastCorners = null, stableSince = 0, tpl = null, cvReady = false;
  let code = session.codes[0];
  const video = document.createElement("video");
  video.setAttribute("playsinline", ""); video.muted = true; video.autoplay = true;
  const small = document.createElement("canvas");
  small.width = PREVIEW_W;
  const sctx = small.getContext("2d", { willReadFrequently: true });

  root.innerHTML = `
    <div class="row between"><h1>Chấm bài</h1></div>
    <div class="card">
      <label>Mã đề</label>
      <select id="cam-code">${session.codes.map((c) => `<option value="${c}">${c}</option>`).join("")}</select>
    </div>
    <div class="cam"><div class="status" id="cam-status">Bấm "Bật camera" rồi đưa phiếu vào khung</div></div>
    <div class="row"><button class="primary big" id="cam-on">Bật camera</button><button class="big" id="cam-off" disabled>Tắt</button></div>
    <div id="cam-msg"></div>
  `;
  const camBox = root.querySelector(".cam");
  camBox.prepend(video);
  const statusEl = root.querySelector("#cam-status");
  const msgEl = root.querySelector("#cam-msg");
  const codeSel = root.querySelector("#cam-code");
  codeSel.onchange = () => { code = codeSel.value; };
  root.querySelector("#cam-on").onclick = start;
  root.querySelector("#cam-off").onclick = stop;

  function say(text, cls = "") { msgEl.innerHTML = text ? `<div class="${cls}">${text}</div>` : ""; }
  function status(text) { statusEl.textContent = text; }

  async function start() {
    // OpenCV.js chỉ nạp khi bấm Bật camera, để các tab khác vẫn dùng được.
    if (!cvReady) {
      status("Đang nạp bộ xử lý ảnh…");
      try {
        await ensureCv((t) => status(`Đang nạp bộ xử lý ảnh… ${t}`));
        cvReady = true;
      } catch (e) {
        say(e.message, "err");
        return;
      }
      status("Bộ xử lý ảnh đã sẵn sàng");
    }
    try {
      tpl = tpl || (await getTemplate(session.template));
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
    } catch (e) {
      say("Không mở được camera. Kiểm tra quyền camera của trình duyệt rồi thử lại.", "err");
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    root.querySelector("#cam-on").disabled = true;
    root.querySelector("#cam-off").disabled = false;
    stableSince = 0; lastCorners = null;
    timer = setInterval(tick, TICK_MS);
    status("Đưa phiếu vào khung");
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    root.querySelector("#cam-on").disabled = false;
    root.querySelector("#cam-off").disabled = true;
    status("Đã tắt camera");
  }

  // Phân tích một khung xem trước. Không xoay, không chụp, chỉ cho biết có đủ 4 góc và đứng yên không.
  async function tick() {
    if (busy || analysing || !cvReady || !tpl || !video.videoWidth) return;
    analysing = true;
    try {
      const h = Math.round((video.videoHeight / video.videoWidth) * PREVIEW_W);
      small.height = h;
      sctx.drawImage(video, 0, 0, PREVIEW_W, h);
      const img = sctx.getImageData(0, 0, PREVIEW_W, h);
      const { quality: q, corners } = await analyseFrame(img);
      if (busy) return;   // đang chụp, bỏ kết quả khung này
      if (!corners || !shapeOk(corners, tpl)) {
        lastCorners = null; stableSince = 0;
        status(corners ? "Phiếu chưa đúng hình, đưa thẳng phiếu vào khung" : "Chưa thấy đủ 4 góc của phiếu");
        return;
      }
      if (q.sharp < QUALITY.sharpMin) { stableSince = 0; status("Hình còn mờ, giữ máy yên"); return; }
      if (q.bright < QUALITY.brightMin) { stableSince = 0; status("Thiếu sáng, bật đèn hoặc đưa ra chỗ sáng hơn"); return; }
      if (q.bright > QUALITY.brightMax) { stableSince = 0; status("Quá sáng, tránh ánh đèn chiếu trực tiếp"); return; }
      const moved = lastCorners ? maxMove(corners, lastCorners) : Infinity;
      lastCorners = corners;
      if (moved > MOVE_PX) { stableSince = Date.now(); status("Giữ yên phiếu…"); return; }
      const held = Date.now() - stableSince;
      const left = Math.max(0, Math.ceil((STABLE_MS - held) / 1000));
      if (held >= STABLE_MS) { capture(); return; }
      status(`Đã thấy 4 góc, giữ yên… ${left}`);
    } catch (e) {
      console.warn(e);
      status("Đang đọc khung hình…");
    } finally {
      analysing = false;
    }
  }

  // Hình dạng gần đúng bất kể xoay (phiếu có thể đang ngược): tỷ lệ cạnh khớp mẫu, góc nghiêng không quá 15 độ.
  function shapeOk(c, t) {
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const top = d(c.tl, c.tr), left = d(c.tl, c.bl);
    if (!top || !left) return false;
    const f = t.fiducials;
    const expected = (f.tr[0] - f.tl[0]) / (f.bl[1] - f.tl[1]);   // rộng / cao của khung chuẩn
    const ratio = top / left;
    const okRatio = Math.abs(ratio / expected - 1) < 0.15 || Math.abs(1 / ratio / expected - 1) < 0.15;
    const angle = (Math.atan2(c.tr.y - c.tl.y, c.tr.x - c.tl.x) * 180) / Math.PI;
    const tilt = Math.abs(((angle % 90) + 90) % 90);
    return okRatio && (tilt <= 15 || tilt >= 75);
  }

  function maxMove(a, b) {
    return Math.max(...["tl", "tr", "br", "bl"].map((k) => Math.hypot(a[k].x - b[k].x, a[k].y - b[k].y)));
  }

  // Chụp khung hình đầy đủ rồi chấm
  async function capture() {
    busy = true;
    if (timer) clearInterval(timer);
    timer = null;
    status("Đang chấm…");
    const W = video.videoWidth, H = video.videoHeight;
    const full = document.createElement("canvas");
    full.width = W; full.height = H;
    full.getContext("2d").drawImage(video, 0, 0, W, H);
    try {
      const photoBlob = await canvasToBlob(full, 0.85);
      const res = await processPhoto(full.getContext("2d").getImageData(0, 0, W, H), tpl);
      const alignedCanvas = grayToCanvas(res.data, res.w, res.h);
      const alignedBlob = await canvasToBlob(alignedCanvas, 0.9);
      const sheet = await gradeAndSave({ tpl, darkness: res.darkness, alignedBlob, photoBlob, chosenCode: code });
      if (sheet.status === "GRADED") {
        say(`Đã chấm mã ${sheet.code}: <b>${fmt(sheet.total)}</b> điểm`, "ok");
        status("Đưa phiếu tiếp theo vào khung");
        onSaved && onSaved(sheet);
        resume();
      } else {
        stop();
        onOpenReview && onOpenReview(sheet.id);
      }
    } catch (e) {
      console.warn(e);
      const msg = e.name === "AlignError" ? e.message : "Không chấm được phiếu này. Thử chụp lại.";
      say(`${msg}. Đưa phiếu thẳng và chụp lại.`, "err");
      resume();
    }
  }

  function resume() {
    busy = false;
    lastCorners = null; stableSince = 0;
    if (stream) timer = setInterval(tick, TICK_MS);
  }

  // Dùng chung với màn Kiểm tra: tạo bản ghi bài, lưu, trả về bản ghi
  async function gradeAndSave({ tpl, darkness, alignedBlob, photoBlob, chosenCode }) {
    const read = readItems(tpl, darkness);
    const codeRead = readDigits(read, "code", 4);
    const keys = session.keys[chosenCode];
    const warnings = [];
    if (!keys) warnings.push(`Mã đề ${chosenCode} chưa có đáp án`);
    if (codeRead.ok && codeRead.value !== chosenCode) warnings.push(`Mã đề trên phiếu là ${codeRead.value}, khác mã đã chọn ${chosenCode}`);
    if (!codeRead.ok) warnings.push("Không đọc đủ mã đề trên phiếu");
    let grade = null;
    if (keys) grade = gradeSheet(read, keys, session.structure, session.scoring);
    const needs = !grade || grade.status !== "GRADED" || warnings.length > 0;
    const sheet = {
      id: newId(),
      sessionId: session.id,
      code: chosenCode,
      createdAt: Date.now(),
      darkness,
      overrides: {},
      alignedBlob,
      photoBlob,
      warnings,
      status: needs ? "NEEDS_REVIEW" : "GRADED",
      parts: grade ? grade.parts : { p1: 0, p2: 0, p3: 0 },
      total: grade ? grade.total : 0,
    };
    await sheets.put(sheet);
    return sheet;
  }

  return { stop };
}

