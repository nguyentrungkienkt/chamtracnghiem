// Màn chấm bằng camera: khung hướng dẫn 4 ô vuông, dò góc, tự chụp khi phiếu khớp khung và đứng yên, rồi chấm.
// Mã đề đọc từ chính phiếu, không chọn trước.
import { QUALITY } from "./omr.js";
import { ensureCv, analyseFrame, processPhoto } from "./cv-client.js";
import { readItems, gradeSheet, readDigits } from "../lib/grading.js";
import { grayToCanvas, canvasToBlob } from "./render.js";
import { sheets, newId } from "./db.js";
import { getTemplate } from "./templates.js";
import { fmt } from "./shared.js";

const PREVIEW_W = 480;        // ảnh xem trước để dò góc nhanh
const STABLE_MS = 3000;       // phiếu khớp khung và đứng yên bao lâu thì tự chụp
const MOVE_PX = 8;            // dịch chuyển góc tối đa (px, trên ảnh xem trước) vẫn tính là đứng yên
const ALIGN_TOL = 0.06;       // sai lệch cho phép giữa góc phát hiện và ô vuông hướng dẫn (tỷ lệ theo chiều rộng xem trước)
const TICK_MS = 200;          // chu kỳ phân tích khung hình
const CORNERS = ["tl", "tr", "br", "bl"];
const CORNER_TEXT = { tl: "trên trái", tr: "trên phải", br: "dưới phải", bl: "dưới trái" };

export function mountScan(root, { session, onSaved }) {
  let stream = null, timer = null, busy = false, analysing = false, lastCorners = null, stableSince = 0, tpl = null, cvReady = false;
  const video = document.createElement("video");
  video.setAttribute("playsinline", ""); video.muted = true; video.autoplay = true;
  const small = document.createElement("canvas");
  small.width = PREVIEW_W;
  const sctx = small.getContext("2d", { willReadFrequently: true });

  root.innerHTML = `
    <div class="cam">
      <div class="guides" id="guides">${CORNERS.map((k) => `<i class="gmark" data-k="${k}"></i>`).join("")}</div>
      <div class="status" id="cam-status">Bấm "Bật camera", rồi đưa phiếu cho 4 ô vuông khớp khung</div>
    </div>
    <div class="row"><button class="primary big" id="cam-on">Bật camera</button><button class="big" id="cam-off" disabled>Tắt</button></div>
    <div id="cam-msg"></div>
  `;
  const camBox = root.querySelector(".cam");
  camBox.prepend(video);
  const statusEl = root.querySelector("#cam-status");
  const msgEl = root.querySelector("#cam-msg");
  const guidesEl = root.querySelector("#guides");
  root.querySelector("#cam-on").onclick = start;
  root.querySelector("#cam-off").onclick = stop;

  function say(text, cls = "") { msgEl.innerHTML = text ? `<div class="${cls}">${text}</div>` : ""; }
  function status(text) { statusEl.textContent = text; }

  // Vị trí khung hướng dẫn trên ảnh xem trước: hộp cao 80% khung, giữ tỷ lệ của phiếu, căn giữa.
  function guideBox(h) {
    const bh = 0.8 * h, bw = bh * (tpl.ref_w / tpl.ref_h);
    return { x0: (PREVIEW_W - bw) / 2, y0: 0.1 * h, bw, bh };
  }

  function guidePoints(h) {
    const { x0, y0, bw, bh } = guideBox(h);
    const out = {};
    for (const k of CORNERS) {
      out[k] = { x: x0 + (tpl.fiducials[k][0] / tpl.ref_w) * bw, y: y0 + (tpl.fiducials[k][1] / tpl.ref_h) * bh };
    }
    return out;
  }

  function placeGuides() {
    guidesEl.style.aspectRatio = `${tpl.ref_w} / ${tpl.ref_h}`;
    for (const k of CORNERS) {
      const el = guidesEl.querySelector(`[data-k="${k}"]`);
      el.style.left = `${(tpl.fiducials[k][0] / tpl.ref_w) * 100}%`;
      el.style.top = `${(tpl.fiducials[k][1] / tpl.ref_h) * 100}%`;
    }
  }

  function setGuideState(cls) {
    guidesEl.classList.remove("ok", "near");
    if (cls) guidesEl.classList.add(cls);
  }

  async function start() {
    // OpenCV.js chạy trong luồng nền, chỉ nạp khi bấm Bật camera.
    if (!cvReady) {
      status("Đang nạp bộ xử lý ảnh…");
      try {
        await ensureCv((t) => status(`Đang nạp bộ xử lý ảnh… ${t}`));
        cvReady = true;
      } catch (e) {
        say(e.message, "err");
        return;
      }
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
    placeGuides();
    video.srcObject = stream;
    await video.play().catch(() => {});
    root.querySelector("#cam-on").disabled = true;
    root.querySelector("#cam-off").disabled = false;
    stableSince = 0; lastCorners = null;
    timer = setInterval(tick, TICK_MS);
    status("Đưa phiếu cho 4 ô vuông khớp khung");
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    root.querySelector("#cam-on").disabled = false;
    root.querySelector("#cam-off").disabled = true;
    setGuideState("");
    status("Đã tắt camera");
  }

  // Phân tích một khung xem trước: phiếu có khớp khung không, sáng và rõ không, có đứng yên không.
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
      if (!corners) {
        lastCorners = null; stableSince = 0; setGuideState("");
        status("Chưa thấy đủ 4 góc của phiếu. Đưa phiếu vào khung, đủ sáng.");
        return;
      }
      if (!shapeOk(corners, tpl)) {
        lastCorners = null; stableSince = 0; setGuideState("");
        status("Phiếu bị nghiêng hoặc xoay. Đặt phiếu thẳng, đầu phiếu ở trên.");
        return;
      }
      const align = alignHint(corners, guidePoints(h));
      if (!align.ok) {
        lastCorners = null; stableSince = 0;
        setGuideState("near");
        status(align.text);
        return;
      }
      setGuideState("ok");
      if (q.sharp < QUALITY.sharpMin) { stableSince = 0; status("Khớp khung, nhưng hình còn mờ. Giữ máy yên."); return; }
      if (q.bright < QUALITY.brightMin) { stableSince = 0; status("Khớp khung, nhưng thiếu sáng. Bật đèn hoặc ra chỗ sáng hơn."); return; }
      if (q.bright > QUALITY.brightMax) { stableSince = 0; status("Khớp khung, nhưng quá sáng. Tránh ánh đèn chiếu trực tiếp."); return; }
      const moved = lastCorners ? maxMove(corners, lastCorners) : Infinity;
      lastCorners = corners;
      if (moved > MOVE_PX || !stableSince) { stableSince = Date.now(); status("Khớp khung. Giữ yên phiếu…"); return; }
      const held = Date.now() - stableSince;
      const left = Math.max(0, Math.ceil((STABLE_MS - held) / 1000));
      if (held >= STABLE_MS) { capture(); return; }
      status(`Khớp khung. Giữ yên, chụp sau ${left} giây`);
    } catch (e) {
      console.warn(e);
      status("Đang đọc khung hình…");
    } finally {
      analysing = false;
    }
  }

  // So góc phát hiện với 4 ô vuông hướng dẫn. Nếu chưa khớp, gợi ý cách chỉnh máy.
  function alignHint(c, g) {
    const W = PREVIEW_W;
    const off = CORNERS.filter((k) => Math.hypot(c[k].x - g[k].x, c[k].y - g[k].y) > ALIGN_TOL * W);
    if (off.length === 0) return { ok: true, text: "" };
    const avg = (p, k) => CORNERS.reduce((s, n) => s + p[n][k], 0) / 4;
    const dw = Math.hypot(c.tr.x - c.tl.x, c.tr.y - c.tl.y), gw = Math.hypot(g.tr.x - g.tl.x, g.tr.y - g.tl.y);
    const scale = dw / gw;
    const hints = [];
    if (scale < 0.9) hints.push("lại gần hơn");
    else if (scale > 1.1) hints.push("lùi ra xa hơn");
    const dx = avg(c, "x") - avg(g, "x"), dy = avg(c, "y") - avg(g, "y");
    if (Math.abs(dx) > ALIGN_TOL * W) hints.push(dx < 0 ? "đưa máy sang trái" : "đưa máy sang phải");
    if (Math.abs(dy) > ALIGN_TOL * W) hints.push(dy < 0 ? "đưa máy lên trên" : "đưa máy xuống dưới");
    const text = hints.length
      ? `Chưa khớp: ${hints.join(", ")}.`
      : `Chưa khớp: chỉnh góc ${CORNER_TEXT[off[0]]} vào ô vuông.`;
    return { ok: false, text };
  }

  // Hình dạng gần đúng bất kể xoay: tỷ lệ cạnh khớp mẫu, góc nghiêng không quá 15 độ.
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
    return Math.max(...CORNERS.map((k) => Math.hypot(a[k].x - b[k].x, a[k].y - b[k].y)));
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
      const sheet = await gradeAndSave({ tpl, darkness: res.darkness, alignedBlob, photoBlob });
      if (sheet.status === "GRADED") {
        say(`Đã chấm mã ${sheet.code}: <b>${fmt(sheet.total)}</b> điểm`, "ok");
      } else {
        say(`Mã ${sheet.code === "?" ? "chưa đọc được" : sheet.code}: cần xem lại. Xem trong tab Bài.`, "err");
      }
      status("Đưa phiếu tiếp theo cho 4 ô vuông khớp khung");
      onSaved && onSaved(sheet);
      resume();
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

  // Mã đề đọc từ phiếu; nếu không đọc được hoặc chưa có đáp án thì ghi nhận để xem lại.
  async function gradeAndSave({ tpl, darkness, alignedBlob, photoBlob }) {
    const read = readItems(tpl, darkness);
    const codeRead = readDigits(read, "code", 4);
    const code = codeRead.ok ? codeRead.value : "?";
    const keys = codeRead.ok ? session.keys[code] : null;
    const warnings = [];
    if (!codeRead.ok) warnings.push("Không đọc đủ mã đề trên phiếu");
    else if (!keys) warnings.push(`Mã đề ${code} chưa có đáp án trong file`);
    let grade = null;
    if (keys) grade = gradeSheet(read, keys, session.structure, session.scoring);
    const needs = !grade || grade.status !== "GRADED" || warnings.length > 0;
    const sheet = {
      id: newId(),
      sessionId: session.id,
      code,
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
