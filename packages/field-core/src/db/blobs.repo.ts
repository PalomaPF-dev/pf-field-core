import type { FieldDB } from "./open.js";
import { blobKey, type StoredBlob } from "./schema.js";

/**
 * 添付の実体（画像 Blob）の出し入れ。
 *
 * ジョブ本体と分けてあるので、一覧表示では触らない。
 * サムネイルが要るときだけ、その1件を読む。
 */

export async function putBlob(
  db: FieldDB,
  jobId: string,
  attachmentId: string,
  blob: Blob,
): Promise<void> {
  const record: StoredBlob = {
    id: blobKey(jobId, attachmentId),
    jobId,
    attachmentId,
    blob,
    bytes: blob.size,
  };
  await db.put("blobs", record);
}

export async function getBlob(
  db: FieldDB,
  jobId: string,
  attachmentId: string,
): Promise<Blob | undefined> {
  const record = await db.get("blobs", blobKey(jobId, attachmentId));
  return record?.blob;
}

export async function deleteBlob(
  db: FieldDB,
  jobId: string,
  attachmentId: string,
): Promise<void> {
  await db.delete("blobs", blobKey(jobId, attachmentId));
}

/** ジョブに属する添付をまとめて消す。ジョブ削除・成功時の後始末に使う。 */
export async function deleteBlobsForJob(db: FieldDB, jobId: string): Promise<number> {
  const tx = db.transaction("blobs", "readwrite");
  const index = tx.store.index("by-job");
  let deleted = 0;
  for await (const cursor of index.iterate(jobId)) {
    await cursor.delete();
    deleted++;
  }
  await tx.done;
  return deleted;
}

/**
 * どのジョブにも属さない Blob を掃除する。
 *
 * 「ジョブは消えたが Blob が残る」事故は、書き込み途中で WebView が落ちると起きる。
 * 端末の容量を静かに食い潰すので、起動時に一度だけ確認する。
 */
export async function deleteOrphanBlobs(db: FieldDB): Promise<number> {
  const jobIds = new Set(await db.getAllKeys("jobs"));
  const tx = db.transaction("blobs", "readwrite");
  let deleted = 0;
  for await (const cursor of tx.store.iterate()) {
    if (!jobIds.has(cursor.value.jobId)) {
      await cursor.delete();
      deleted++;
    }
  }
  await tx.done;
  return deleted;
}

/** 保存されている添付の合計バイト数。 */
export async function totalBlobBytes(db: FieldDB): Promise<number> {
  let total = 0;
  const tx = db.transaction("blobs", "readonly");
  for await (const cursor of tx.store.iterate()) {
    total += cursor.value.bytes;
  }
  await tx.done;
  return total;
}
