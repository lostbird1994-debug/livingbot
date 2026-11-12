/** File objects survive closing a task tab and reloading, until its send is accepted. */
export interface TaskDraftFile { id: string; name: string; type: string; size: number; file?: File; artifactId?: string }
let database: Promise<IDBDatabase> | undefined;
function db() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("rakazo-task-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
  return database;
}
export async function readTaskDraftFiles(key: string): Promise<TaskDraftFile[]> {
  const store = (await db()).transaction("files", "readonly").objectStore("files");
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  });
}
export async function writeTaskDraftFiles(key: string, files: TaskDraftFile[]) {
  const transaction = (await db()).transaction("files", "readwrite");
  transaction.objectStore("files").put(files, key);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
