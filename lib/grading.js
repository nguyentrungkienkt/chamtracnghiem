// Phân loại ô và chấm bài theo quy tắc đã chốt. Hàm thuần: không đụng camera, không đụng DOM.
//
// Đầu vào: điểm đen (darkness 0..1) của từng ô, lấy từ bước xử lý ảnh (OpenCV.js) ở app/.
// Đầu ra: trạng thái từng mục, điểm từng câu, và danh sách nét vẽ cho ảnh đã chấm.
//
// Quy tắc (xem claude/quyet-dinh-hien-thi-va-cham.md):
//  - Phần I, II: đúng khi ô học sinh tô khớp đáp án. Câu trống tính 0.
//  - Phần III: đúng khi toàn bộ chuỗi khớp đáp án. Sai thì đỏ mọi cột đáp án và mọi cột học sinh tô.
//  - Ô mờ, tô nhiều, hoặc không đọc được: vàng, câu đó chờ người chấm xác nhận, chưa tính điểm.

export const TH = {
  blankMax: 0.15,        // dưới ngưỡng: không tô
  digitBlankMax: 0.25,   // chữ số có số in sẵn bên trong, nền khoảng 0.1–0.2
  markMin: 0.35,         // trên ngưỡng: đã tô
  secondMaxRatio: 0.5,   // ô thứ hai phải <= tỷ lệ này * ô mạnh nhất để là CLEAR
};

export const BLANK = "BLANK", CLEAR = "CLEAR", UNCERTAIN = "UNCERTAIN", MULTIPLE = "MULTIPLE", REVIEW = "REVIEW";
const UNSURE = new Set([UNCERTAIN, MULTIPLE, REVIEW]);

// Phân loại một nhóm ô (một câu, một ý, hoặc một cột Phần III).
// scores: điểm đen của từng ô; labels: nhãn tương ứng.
export function classify(scores, labels, th = TH) {
  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const v1 = scores[order[0]] ?? 0;
  const v2 = scores.length > 1 ? scores[order[1]] : 0;
  const top = labels[order[0]];
  if (v1 < th.blankMax) return { status: BLANK, suggestion: "", reason: "" };
  if (v1 >= th.markMin && v2 >= th.markMin) return { status: MULTIPLE, suggestion: top, reason: "tô nhiều đáp án" };
  if (v1 >= th.markMin && v2 <= th.secondMaxRatio * v1) return { status: CLEAR, suggestion: top, reason: "" };
  return { status: UNCERTAIN, suggestion: top, reason: "tô mờ hoặc không đủ tách biệt" };
}

// Đọc toàn bộ item của một mẫu phiếu.
// tpl: {items: [{key, kind, labels, radius}]} (xem lib/templates.json)
// darkness: {key: [điểm đen theo thứ tự labels]}
export function readItems(tpl, darkness, th = TH) {
  const out = {};
  for (const spec of tpl.items) {
    const scores = darkness[spec.key] || spec.labels.map(() => 0);
    const useTh = spec.kind === "digit" ? { ...th, blankMax: th.digitBlankMax } : th;
    let r = classify(scores, spec.labels, useTh);
    if (spec.kind === "digit" && r.status === BLANK) r = { ...r, status: REVIEW, reason: "chưa tô chữ số" };
    out[spec.key] = { ...r, scores, labels: spec.labels, kind: spec.kind };
  }
  return out;
}

// Chuẩn hoá đáp án Phần III để so sánh: bỏ khoảng trắng, dấu chấm thành dấu phẩy.
export function normP3(v) {
  return String(v ?? "").trim().replace(/\s+/g, "").replace(/\./g, ",");
}

// Chấm một bài.
// read: kết quả readItems. keys: {item_key: đáp án đúng}. structure: {p1Count, p2Count, p3Count}.
// scoring: {p1PerQ, p2PerQ, p2Scale, p3PerQ}. Điểm tính theo đơn vị 1/100 để tránh sai số.
export function gradeSheet(read, keys, structure, scoring) {
  const hundredths = (x) => Math.round(Number(x) * 100);
  const pending = [];        // câu chưa chắc, cần người chấm: [{item, question, reason}]
  const questions = [];      // [{part, q, status, points, student, key}]
  let p1 = 0, p2 = 0, p3 = 0;

  // Phần I
  for (let q = 1; q <= structure.p1Count; q++) {
    const k = `p1:${q}`;
    const r = read[k];
    const key = keys[k] || "";
    if (!r) { questions.push({ part: 1, q, status: "MISSING", points: 0, student: "", key }); continue; }
    if (UNSURE.has(r.status)) {
      pending.push({ item: k, question: q, part: 1, reason: r.reason });
      questions.push({ part: 1, q, status: "PENDING", points: null, student: "", key });
      continue;
    }
    const student = r.status === CLEAR ? r.suggestion : "";
    const ok = student !== "" && student === key;
    if (ok) p1 += hundredths(scoring.p1PerQ);
    questions.push({ part: 1, q, status: ok ? "RIGHT" : "WRONG", points: ok ? scoring.p1PerQ : 0, student, key });
  }

  // Phần II: đếm số ý đúng rồi tra bảng điểm
  for (let q = 1; q <= structure.p2Count; q++) {
    const subs = ["a", "b", "c", "d"];
    let correct = 0, bad = false, studentParts = [];
    for (const s of subs) {
      const k = `p2:${q}:${s}`;
      const r = read[k];
      const key = keys[k] || "";
      if (!r) { bad = true; continue; }
      if (UNSURE.has(r.status)) { pending.push({ item: k, question: q, part: 2, reason: r.reason }); bad = true; continue; }
      const student = r.status === CLEAR ? r.suggestion : "";
      studentParts.push(`${s}:${student || "-"}`);
      if (student !== "" && student === key) correct++;
    }
    if (bad) { questions.push({ part: 2, q, status: "PENDING", points: null, correct: null }); continue; }
    const ratio = Number(scoring.p2Scale[String(correct)] ?? 0);
    const pts = hundredths(ratio * scoring.p2PerQ) / 100;
    p2 += Math.round(ratio * scoring.p2PerQ * 100);
    questions.push({ part: 2, q, status: correct === 4 ? "RIGHT" : correct === 0 ? "WRONG" : "PARTIAL", points: pts, correct, student: studentParts.join(" ") });
  }

  // Phần III: ghép các cột, so chuỗi
  for (let q = 1; q <= structure.p3Count; q++) {
    const cols = [];
    let unsure = null, gap = false, seenBlank = false;
    for (let p = 1; p <= 4; p++) {
      const k = `p3:${q}:${p}`;
      const r = read[k];
      if (!r) { cols.push(""); continue; }
      if (UNSURE.has(r.status)) { unsure = unsure || { item: k, reason: r.reason }; cols.push(""); continue; }
      const sym = r.status === CLEAR ? r.suggestion : "";
      if (sym === "") seenBlank = true;
      else if (seenBlank) gap = true;
      cols.push(sym);
    }
    const student = cols.join("");
    const key = normP3(keys[`p3:${q}`]);
    if (unsure) { pending.push({ item: unsure.item, question: q, part: 3, reason: unsure.reason }); questions.push({ part: 3, q, status: "PENDING", points: null, student, key }); continue; }
    if (gap) { pending.push({ item: `p3:${q}`, question: q, part: 3, reason: "có ô trống giữa các ô đã tô" }); questions.push({ part: 3, q, status: "PENDING", points: null, student, key }); continue; }
    const ok = student !== "" && student === key;
    if (ok) p3 += hundredths(scoring.p3PerQ);
    questions.push({ part: 3, q, status: ok ? "RIGHT" : "WRONG", points: ok ? scoring.p3PerQ : 0, student, key });
  }

  // Mã đề và SBD: không tính điểm, chỉ cảnh báo
  const digitFlags = Object.keys(read).filter((k) => read[k].kind === "digit" && read[k].status !== CLEAR);
  const hasPending = pending.length > 0 || digitFlags.length > 0;
  const total = (p1 + p2 + p3) / 100;
  return {
    status: hasPending ? "NEEDS_REVIEW" : "GRADED",
    parts: { p1: p1 / 100, p2: p2 / 100, p3: p3 / 100 },
    total,
    questions,
    pending,
    digitFlags,
  };
}

// Danh sách nét vẽ cho ảnh đã chấm. Mỗi nét: {key, label, mark}.
// mark: "tick" (xanh đặc), "cross" (đỏ đặc), "ghost" (viền xanh nét đứt), "dashedRed" (viền đỏ nét đứt), "flag" (vàng).
export function decorate(tpl, read, keys, structure) {
  const out = [];
  const add = (key, label, mark) => out.push({ key, label, mark });
  const flagAll = (key, r) => {
    r.labels.forEach((lab, i) => {
      const th = r.kind === "digit" ? TH.digitBlankMax : TH.blankMax;
      if (r.scores[i] >= th) add(key, lab, "flag");
    });
  };

  for (const [k, r] of Object.entries(read)) {
    if (r.kind === "digit") { if (r.status !== CLEAR) flagAll(k, r); continue; }
    if (r.kind === "option" || r.kind === "tf") {
      if (UNSURE.has(r.status)) { flagAll(k, r); continue; }
      const key = keys[k] || "";
      const student = r.status === CLEAR ? r.suggestion : "";
      if (student && student === key) add(k, student, "tick");
      else if (student) { add(k, student, "cross"); if (key) add(k, key, "ghost"); }
      else if (key) add(k, key, "ghost");
    }
  }

  for (let q = 1; q <= structure.p3Count; q++) {
    const items = [];
    for (let p = 1; p <= 4; p++) {
      const k = `p3:${q}:${p}`;
      if (read[k]) items.push({ k, r: read[k] });
    }
    if (items.length === 0) continue;
    const pendingHere = items.some(({ r }) => UNSURE.has(r.status));
    if (pendingHere) { items.forEach(({ k, r }) => { if (UNSURE.has(r.status)) flagAll(k, r); }); continue; }
    const keyStr = normP3(keys[`p3:${q}`]);
    const cols = items.map(({ r }) => (r.status === CLEAR ? r.suggestion : ""));
    const student = cols.join("");
    const ok = student !== "" && student === keyStr;
    items.forEach(({ k }, i) => {
      const s = cols[i];
      const kc = keyStr[i] || "";
      if (ok) { if (s) add(k, s, "tick"); return; }
      if (s) add(k, s, "cross");
      if (kc && kc !== s) add(k, kc, "dashedRed");
    });
  }
  return out;
}
