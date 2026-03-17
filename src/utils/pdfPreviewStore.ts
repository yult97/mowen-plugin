const PDF_PREVIEW_DB_NAME = 'mowen-pdf-preview-db';
const PDF_PREVIEW_STORE_NAME = 'pdf-previews';
const PDF_PREVIEW_DB_VERSION = 1;
const PDF_PREVIEW_TTL_MS = 6 * 60 * 60 * 1000;

export interface PdfPreviewEntry {
  id: string;
  fileName: string;
  blob: Blob;
  createdAt: number;
}

let pdfPreviewDatabasePromise: Promise<IDBDatabase> | null = null;

function waitForRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function openPdfPreviewDatabase(): Promise<IDBDatabase> {
  if (!pdfPreviewDatabasePromise) {
    pdfPreviewDatabasePromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(PDF_PREVIEW_DB_NAME, PDF_PREVIEW_DB_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(PDF_PREVIEW_STORE_NAME)) {
          database.createObjectStore(PDF_PREVIEW_STORE_NAME, { keyPath: 'id' });
        }
      };

      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          pdfPreviewDatabasePromise = null;
        };
        resolve(database);
      };

      request.onerror = () => {
        reject(request.error ?? new Error('Failed to open PDF preview database'));
      };
    });
  }

  return pdfPreviewDatabasePromise;
}

async function purgeExpiredPdfPreviews(database: IDBDatabase, now = Date.now()): Promise<void> {
  const transaction = database.transaction(PDF_PREVIEW_STORE_NAME, 'readwrite');
  const store = transaction.objectStore(PDF_PREVIEW_STORE_NAME);
  const entries = await waitForRequest(store.getAll()) as PdfPreviewEntry[];

  for (const entry of entries) {
    if (now - entry.createdAt > PDF_PREVIEW_TTL_MS) {
      store.delete(entry.id);
    }
  }

  await waitForTransaction(transaction);
}

/**
 * 保存单份 PDF 预览数据，供独立预览页读取。
 */
export async function savePdfPreviewEntry(entry: PdfPreviewEntry): Promise<void> {
  const database = await openPdfPreviewDatabase();
  await purgeExpiredPdfPreviews(database, entry.createdAt);

  const transaction = database.transaction(PDF_PREVIEW_STORE_NAME, 'readwrite');
  transaction.objectStore(PDF_PREVIEW_STORE_NAME).put(entry);
  await waitForTransaction(transaction);
}

/**
 * 读取指定的 PDF 预览数据。
 */
export async function getPdfPreviewEntry(id: string): Promise<PdfPreviewEntry | null> {
  if (!id.trim()) {
    return null;
  }

  const database = await openPdfPreviewDatabase();
  await purgeExpiredPdfPreviews(database);

  const transaction = database.transaction(PDF_PREVIEW_STORE_NAME, 'readonly');
  const entry = await waitForRequest(transaction.objectStore(PDF_PREVIEW_STORE_NAME).get(id));
  await waitForTransaction(transaction);

  return (entry as PdfPreviewEntry | undefined) ?? null;
}
