// Vẽ ảnh đã chấm trên canvas và đóng gói ảnh. Không phụ thuộc OpenCV.
export const COLOR = { green: "#1b9e4b", red: "#d92d20", yellow: "#f5b400", ink: "#1d2433" };

// Chuyển mảng xám (đã nắn, kích thước khung chuẩn) thành canvas
export function grayToCanvas(data, w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    img.data[j] = img.data[j + 1] = img.data[j + 2] = data[i];
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

export function canvasToBlob(canvas, quality = 0.85) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Không xuất được ảnh"))), "image/jpeg", quality);
  });
}

function circle(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); }

function dashedRing(ctx, x, y, r, color, width) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash([r * 0.35, r * 0.25]);
  circle(ctx, x, y, r); ctx.stroke();
  ctx.restore();
}

// Vẽ một nét lên ảnh. Tọa độ theo khung chuẩn.
function drawMark(ctx, x, y, r, mark) {
  if (mark === "tick") {
    ctx.fillStyle = COLOR.green; circle(ctx, x, y, r); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = r * 0.28; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(x - r * 0.5, y); ctx.lineTo(x - r * 0.15, y + r * 0.45); ctx.lineTo(x + r * 0.55, y - r * 0.4); ctx.stroke();
  } else if (mark === "cross") {
    ctx.fillStyle = COLOR.red; circle(ctx, x, y, r); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = r * 0.28; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x - r * 0.45, y - r * 0.45); ctx.lineTo(x + r * 0.45, y + r * 0.45);
    ctx.moveTo(x + r * 0.45, y - r * 0.45); ctx.lineTo(x - r * 0.45, y + r * 0.45); ctx.stroke();
  } else if (mark === "ghost") {
    dashedRing(ctx, x, y, r * 1.05, COLOR.green, r * 0.22);
  } else if (mark === "dashedRed") {
    dashedRing(ctx, x, y, r * 1.05, COLOR.red, r * 0.22);
  } else if (mark === "flag") {
    ctx.strokeStyle = COLOR.yellow; ctx.lineWidth = r * 0.3;
    circle(ctx, x, y, r * 1.35); ctx.stroke();
  }
}

// Vẽ ảnh đã chấm. alignedBlob: ảnh xám đã nắn. decorations: danh sách {key, label, mark} từ grading.decorate.
export async function drawGraded({ tpl, alignedBlob, decorations, scoreLines, grid = false }) {
  const W = tpl.ref_w, H = tpl.ref_h;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H + 120;     // thêm dải chân trang để in điểm
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const img = await blobToImage(alignedBlob);
  ctx.drawImage(img, 0, 0, W, H);

  if (grid) {
    // Lưới kiểm tra căn chỉnh: vòng mảnh màu xanh dương tại mọi vị trí ô theo mẫu
    ctx.strokeStyle = "rgba(0,120,255,0.8)"; ctx.lineWidth = 2;
    for (const it of tpl.items) for (const [x, y] of it.centers) { ctx.beginPath(); ctx.arc(x, y, it.radius, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = "rgba(255,0,200,0.9)";
    for (const f of Object.values(tpl.fiducials)) { ctx.beginPath(); ctx.arc(f[0], f[1], 8, 0, Math.PI * 2); ctx.fill(); }
  }

  const items = new Map(tpl.items.map((it) => [it.key, it]));
  for (const d of decorations) {
    const it = items.get(d.key);
    if (!it) continue;
    const idx = it.labels.indexOf(d.label);
    if (idx < 0) continue;
    const [x, y] = it.centers[idx];
    drawMark(ctx, x, y, it.radius, d.mark);
  }

  if (scoreLines && scoreLines.length) {
    ctx.fillStyle = "#fff"; ctx.fillRect(0, H, W, 120);
    ctx.fillStyle = COLOR.ink; ctx.font = "bold 44px system-ui, sans-serif"; ctx.textBaseline = "middle";
    ctx.fillText(scoreLines[0], 40, H + 40);
    if (scoreLines[1]) ctx.fillText(scoreLines[1], 40, H + 90);
  }
  return canvas;
}
