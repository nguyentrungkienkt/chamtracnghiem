// Gọi relay Drive (relay/Code.gs). Địa chỉ và mã truy cập lưu trên máy này, không nằm trong mã nguồn.
// Content-Type text/plain để tránh preflight CORS khi gọi Apps Script.

const KEY = "chamtn.relay";

export function getConfig() {
  try {
    const cfg = JSON.parse(localStorage.getItem(KEY) || "null");
    return cfg && cfg.url && cfg.code ? cfg : null;
  } catch (e) {
    return null;
  }
}

export function saveConfig(url, code) {
  localStorage.setItem(KEY, JSON.stringify({ url: url.trim(), code: code.trim() }));
}

export function clearConfig() {
  try { localStorage.removeItem(KEY); } catch (e) { /* bỏ qua */ }
}

async function call(action, payload = {}) {
  const cfg = getConfig();
  if (!cfg) throw new Error("Chưa cài đặt kết nối");
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, code: cfg.code, ...payload }),
  });
  if (!res.ok) throw new Error(`Lỗi kết nối (${res.status})`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || "Lỗi không xác định");
  return body;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result);
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function ping() {
  return call("ping");
}

export async function uploadBlob(blob, name, mime) {
  const data = await blobToBase64(blob);
  return call("upload", { name, mime, data });
}
