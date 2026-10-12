// Tải hình học mẫu phiếu (lib/templates.json) một lần rồi giữ trong bộ nhớ.
let cache = null;

export async function loadTemplates() {
  if (!cache) {
    const res = await fetch("./lib/templates.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("Không tải được mẫu phiếu");
    cache = (await res.json()).templates;
  }
  return cache;
}

// Mã mẫu trong app -> id trong templates.json
export const TEMPLATE_ID = { ptltn2: 2 };   // chỉ dùng một mẫu: phiếu quét 300 dpi

export async function getTemplate(key) {
  const id = TEMPLATE_ID[key] ?? TEMPLATE_ID.ptltn2;   // bài cũ dùng mẫu khác vẫn đọc theo mẫu duy nhất
  return (await loadTemplates()).find((t) => t.id === id);
}
