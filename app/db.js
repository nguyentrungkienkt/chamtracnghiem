// Lưu trữ cục bộ bằng IndexedDB. Mọi thao tác đều có try/catch: lỗi không làm hỏng giao diện.
const DB_NAME = "chamtracnghiem";
const STORE = "sessions";
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: "id" });
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
    const store = tx.objectStore(STORE);
    const req = fn(store);
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const sessions = {
  all: () => run("readonly", (s) => s.getAll()).then((list) => (list || []).sort((a, b) => b.createdAt - a.createdAt)),
  get: (id) => run("readonly", (s) => s.get(id)),
  put: (session) => run("readwrite", (s) => s.put(session)),
  remove: (id) => run("readwrite", (s) => s.delete(id)),
};

export function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}
