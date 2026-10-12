// Lưu trữ cục bộ bằng IndexedDB (v2: thêm kho bài chấm). Mọi thao tác có try/catch ở nơi gọi.
const DB_NAME = "chamtracnghiem";
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
        if (!db.objectStoreNames.contains("sheets")) {
          const st = db.createObjectStore("sheets", { keyPath: "id" });
          st.createIndex("sessionId", "sessionId", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const sessions = {
  all: () => run("sessions", "readonly", (s) => s.getAll())
    .then((list) => (list || []).sort((a, b) => b.createdAt - a.createdAt)),
  get: (id) => run("sessions", "readonly", (s) => s.get(id)),
  put: (session) => run("sessions", "readwrite", (s) => s.put(session)),
  remove: (id) => run("sessions", "readwrite", (s) => s.delete(id)),
};

export const sheets = {
  bySession: (sessionId) => run("sheets", "readonly", (s) => s.index("sessionId").getAll(IDBKeyRange.only(sessionId)))
    .then((list) => (list || []).sort((a, b) => b.createdAt - a.createdAt)),
  get: (id) => run("sheets", "readonly", (s) => s.get(id)),
  put: (sheet) => run("sheets", "readwrite", (s) => s.put(sheet)),
  remove: (id) => run("sheets", "readwrite", (s) => s.delete(id)),
  // Xóa mọi bài của một phiên (dùng khi xóa phiên)
  removeBySession: async (sessionId) => {
    const list = await sheets.bySession(sessionId);
    for (const s of list) await sheets.remove(s.id);
  },
};

export function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
