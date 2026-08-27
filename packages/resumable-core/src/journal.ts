import type { Journal, JournalEvent, NewJournalEvent } from "./types";

export class MemoryJournal implements Journal {
  private events: JournalEvent[] = [];
  private nextSeq = 1;

  async append(event: NewJournalEvent): Promise<JournalEvent> {
    const complete = structuredClone<JournalEvent>({
      ...event,
      seq: this.nextSeq++,
      at: event.at ?? Date.now(),
    });
    this.events.push(complete);
    return structuredClone(complete);
  }

  async list(workflowId?: string): Promise<JournalEvent[]> {
    const events = workflowId
      ? this.events.filter((event) => event.workflowId === workflowId)
      : this.events;
    return structuredClone([...events].sort((a, b) => a.seq - b.seq));
  }

  async clear(workflowId?: string): Promise<void> {
    if (!workflowId) {
      this.events = [];
      this.nextSeq = 1;
      return;
    }
    this.events = this.events.filter((event) => event.workflowId !== workflowId);
  }
}

export class IndexedDbJournal implements Journal {
  private dbPromise: Promise<IDBDatabase>;

  constructor(
    private readonly dbName = "resumable-demo",
    private readonly storeName = "journal-events",
  ) {
    this.dbPromise = this.open();
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      // Open the current version first. If this is a new database, version 1 is
      // created and the journal schema is installed in onupgradeneeded.
      const request = indexedDB.open(this.dbName);
      request.onupgradeneeded = () => {
        this.ensureSchema(request.result, request.transaction!);
      };
      request.onsuccess = () => {
        const db = request.result;
        if (this.hasSchema(db)) {
          this.finishOpen(db, resolve);
          return;
        }

        // The database can pre-date this store (or another journal can share
        // the database under a different store name). Upgrade exactly once to
        // install the missing schema instead of failing later with NotFoundError.
        const nextVersion = db.version + 1;
        db.close();
        const upgrade = indexedDB.open(this.dbName, nextVersion);
        upgrade.onupgradeneeded = () =>
          this.ensureSchema(upgrade.result, upgrade.transaction!);
        upgrade.onsuccess = () => this.finishOpen(upgrade.result, resolve);
        upgrade.onerror = () => reject(this.openError(upgrade.error));
        upgrade.onblocked = () =>
          reject(new Error(`IndexedDB upgrade blocked for ${this.dbName}`));
      };
      request.onerror = () => reject(this.openError(request.error));
      request.onblocked = () =>
        reject(new Error(`IndexedDB open blocked for ${this.dbName}`));
    });
  }

  private hasSchema(db: IDBDatabase) {
    if (!db.objectStoreNames.contains(this.storeName)) return false;
    const tx = db.transaction(this.storeName, "readonly");
    return tx.objectStore(this.storeName).indexNames.contains("workflowId");
  }

  private ensureSchema(db: IDBDatabase, tx: IDBTransaction) {
    const store = db.objectStoreNames.contains(this.storeName)
      ? tx.objectStore(this.storeName)
      : db.createObjectStore(this.storeName, {
          keyPath: "seq",
          autoIncrement: true,
        });
    if (!store.indexNames.contains("workflowId")) {
      store.createIndex("workflowId", "workflowId", { unique: false });
    }
  }

  private finishOpen(db: IDBDatabase, resolve: (db: IDBDatabase) => void) {
    db.onversionchange = () => db.close();
    resolve(db);
  }

  private openError(error: DOMException | null) {
    return error ?? new Error(`Unable to open IndexedDB database ${this.dbName}`);
  }

  private transactionError(tx: IDBTransaction, operation: string) {
    return tx.error ?? new Error(`IndexedDB ${operation} transaction failed`);
  }

  async append(event: NewJournalEvent): Promise<JournalEvent> {
    const db = await this.dbPromise;
    const at = event.at ?? Date.now();
    // Fail before opening a transaction if the caller supplied data that the
    // structured-clone algorithm cannot persist.
    const payload = structuredClone({ ...event, at });
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const request = store.add(payload);
      let complete: JournalEvent | undefined;
      request.onsuccess = () => {
        complete = { ...payload, seq: Number(request.result) };
      };
      tx.oncomplete = () => resolve(structuredClone(complete!));
      tx.onerror = () => reject(this.transactionError(tx, "append"));
      tx.onabort = () => reject(this.transactionError(tx, "append"));
    });
  }

  async list(workflowId?: string): Promise<JournalEvent[]> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const request = workflowId
        ? store.index("workflowId").getAll(workflowId)
        : store.getAll();
      let events: JournalEvent[] = [];
      request.onsuccess = () => {
        events = (request.result as JournalEvent[]).sort((a, b) => a.seq - b.seq);
      };
      tx.oncomplete = () => resolve(structuredClone(events));
      tx.onerror = () => reject(this.transactionError(tx, "list"));
      tx.onabort = () => reject(this.transactionError(tx, "list"));
    });
  }

  async clear(workflowId?: string): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      if (!workflowId) {
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(this.transactionError(tx, "clear"));
        tx.onabort = () => reject(this.transactionError(tx, "clear"));
        return;
      }

      const index = store.index("workflowId");
      const cursor = index.openCursor(IDBKeyRange.only(workflowId));
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        current.delete();
        current.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(this.transactionError(tx, "workflow clear"));
      tx.onabort = () => reject(this.transactionError(tx, "workflow clear"));
    });
  }
}
