const DB_NAME = "selective-recovery-demo-state";
const DB_VERSION = 1;
const STORE_NAME = "records";

export const DEMO_STORAGE_KEYS = {
  backend: "backend-v1",
  proposal: "recovery-proposal-v1",
} as const;

let dbPromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = undefined;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = undefined;
      reject(request.error ?? new Error(`Unable to open IndexedDB database ${DB_NAME}`));
    };
    request.onblocked = () => {
      dbPromise = undefined;
      reject(new Error(`IndexedDB open blocked for ${DB_NAME}`));
    };
  });

  return dbPromise;
}

function transactionError(tx: IDBTransaction, operation: string) {
  return tx.error ?? new Error(`IndexedDB ${operation} transaction failed`);
}

export async function readDemoRecord<T>(key: string): Promise<T | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () =>
      resolve(request.result === undefined ? undefined : structuredClone(request.result as T));
    request.onerror = () => reject(request.error);
  });
}

export async function writeDemoRecord<T>(key: string, value: T): Promise<void> {
  const persisted = structuredClone(value);
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(persisted, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(transactionError(tx, "write"));
    tx.onabort = () => reject(transactionError(tx, "write"));
  });
}

export async function updateDemoRecord<T, R>(
  key: string,
  initial: () => T,
  update: (current: T) => R,
): Promise<R> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    let result: R;

    request.onsuccess = () => {
      const current = request.result === undefined
        ? initial()
        : structuredClone(request.result as T);
      try {
        result = update(current);
        store.put(current, key);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };
    tx.oncomplete = () => resolve(structuredClone(result!));
    tx.onerror = () => reject(transactionError(tx, "update"));
    tx.onabort = () => reject(transactionError(tx, "update"));
  });
}

export async function clearDemoState(): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(DEMO_STORAGE_KEYS.backend);
    store.delete(DEMO_STORAGE_KEYS.proposal);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(transactionError(tx, "reset"));
    tx.onabort = () => reject(transactionError(tx, "reset"));
  });
}
