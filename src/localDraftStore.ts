import type { AiSolution } from './aiClient';
import type { Stroke } from './types';

export interface StoredPdfDoc {
  id: string;
  fileName: string;
  pages: string[];
  selectedPage: number;
}

export interface StoredQuizDraft {
  key: string;
  composerTab: 'text' | 'board' | 'pdf';
  draftText: string;
  draftImage: string;
  draftBoardStrokes: Stroke[];
  pdfDocs: StoredPdfDoc[];
  activePdfId: string | null;
  draftTimerSeconds?: number;
  draftAiSolution?: AiSolution | null;
  activeAiCache?: Record<string, AiSolution>;
  updatedAt: number;
}

const DB_NAME = 'duoboard_local_store';
const DB_VERSION = 1;
const STORE_NAME = 'quiz_drafts';

function openDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
}

export async function loadQuizDraft(key: string): Promise<StoredQuizDraft | null> {
  try {
    const db = await openDraftDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        resolve((req.result as StoredQuizDraft | undefined) ?? null);
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

export async function saveQuizDraft(draft: StoredQuizDraft): Promise<void> {
  try {
    const db = await openDraftDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(draft);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Ignore storage quota or private-mode errors gracefully
  }
}
