// Hàng đợi gửi lên Drive, lưu trong IndexedDB để không mất khi mất mạng hoặc đóng app.
// Mỗi mục: { id, name, mime, blob, sessionId, createdAt }.
const DB_NAME = "chamtn-queue";
const STORE = "items";
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const queue = {
  put: (item) => run("readwrite", (s) => s.put(item)),
  all: () => run("readonly", (s) => s.getAll()).then((list) => (list || []).sort((a, b) => a.createdAt - b.createdAt)),
  remove: (id) => run("readwrite", (s) => s.delete(id)),
  count: () => run("readonly", (s) => s.count()),
};

export function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
