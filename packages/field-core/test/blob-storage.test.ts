import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromStoredBlob, getBlob, putBlob, toStoredBlob } from "../src/db/blobs.repo.js";
import { openFieldDB, type FieldDB } from "../src/db/open.js";
import { blobKey, type StoredBlob } from "../src/db/schema.js";
import { createOfflineQueue, type OfflineQueueOptions } from "../src/queue/queue.js";
import type { OfflineQueue } from "../src/queue/types.js";
import { noopLogger } from "../src/shared/logger.js";

/**
 * 添付を IndexedDB に「どの形で」置くかの検証。
 *
 * これは書き方の好みの話ではない。WebKit は Blob を IndexedDB に入れるとき
 * ディスク上のファイルへ退避する経路を通り、その経路が使えない状況
 * （プライベートブラウズ、E2E の一時プロファイル）では
 * `UnknownError: Error preparing Blob/File data to be stored in object store`
 * で **書き込みごと失敗する**。実際に iOS Safari の E2E がこれで全滅した。
 *
 * fake-indexeddb は Blob を素直に受けるので、この不具合は単体テストでは再現しない。
 * だからここでは「WebKit が転ぶ形になっていないこと」＝レコードがバイト列であることを
 * 直接押さえる。実挙動の担保は test/e2e/queue.spec.ts の ios-safari 側が持つ。
 */

const passthroughCompress: OfflineQueueOptions["compress"] = async (blob) => ({
  blob,
  width: 100,
  height: 100,
  bytes: blob.size,
  quality: 0.75,
  passes: 1,
  original: { bytes: blob.size, width: 100, height: 100, type: blob.type },
  orientation: 1,
  renderer: "offscreen-main",
  durationMs: 1,
});

let dbCounter = 0;
let db: FieldDB;
let queues: OfflineQueue[] = [];

beforeEach(async () => {
  dbCounter++;
  db = await openFieldDB(`pf-field-blob-test-${dbCounter}`);
  queues = [];
});

afterEach(async () => {
  for (const queue of queues) await queue.destroy();
  db.close();
});

async function makeQueue(): Promise<OfflineQueue> {
  const queue = await createOfflineQueue({
    appId: "test",
    db,
    compress: passthroughCompress,
    logger: noopLogger,
    autoStart: false,
    pollIntervalMs: 0,
    forceIdbLease: true,
  } as OfflineQueueOptions);
  queues.push(queue);
  return queue;
}

function photo(bytes: number, type = "image/jpeg"): Blob {
  const filled = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) filled[i] = i % 251;
  return new Blob([filled as Uint8Array<ArrayBuffer>], { type });
}

describe("添付の保存形式", () => {
  it("enqueue が書くレコードは Blob ではなくバイト列", async () => {
    const queue = await makeQueue();
    const job = await queue.enqueue({
      type: "setsubi.inspection",
      payload: {},
      attachments: [{ blob: photo(2000), fileName: "before.jpg" }],
    });

    const attachmentId = job.attachments[0]!.attachmentId;
    const record = await db.get("blobs", blobKey(job.jobId, attachmentId));

    expect(record).toBeTruthy();
    // ここが Blob に戻ると iOS でキューが丸ごと動かなくなる
    expect(record!.data).toBeInstanceOf(ArrayBuffer);
    expect(record!.blob).toBeUndefined();
    expect(record!.contentType).toBe("image/jpeg");
    expect(record!.bytes).toBe(2000);
  });

  it("読み出すと中身も MIME 型も元のまま", async () => {
    const queue = await makeQueue();
    const original = photo(1500, "image/png");
    const job = await queue.enqueue({
      type: "t",
      payload: {},
      // 圧縮を通すと別物になるので、素通しで比べる
      attachments: [{ blob: original, fileName: "a.png", compress: false }],
    });

    const restored = await queue.getAttachmentBlob(job.jobId, job.attachments[0]!.attachmentId);
    expect(restored).toBeTruthy();
    expect(restored!.type).toBe("image/png");
    expect(restored!.size).toBe(original.size);
    expect(new Uint8Array(await restored!.arrayBuffer())).toEqual(
      new Uint8Array(await original.arrayBuffer()),
    );
  });

  it("putBlob / getBlob も同じ形式で往復する", async () => {
    await putBlob(db, "job-1", "att-1", photo(300, "image/webp"));

    const record = await db.get("blobs", blobKey("job-1", "att-1"));
    expect(record!.data).toBeInstanceOf(ArrayBuffer);

    const restored = await getBlob(db, "job-1", "att-1");
    expect(restored!.size).toBe(300);
    expect(restored!.type).toBe("image/webp");
  });

  it("MIME 型が無い Blob でも読み出せる形にする", async () => {
    const record = await toStoredBlob("job-1", "att-1", new Blob([new Uint8Array(10)]));
    expect(record.contentType).toBe("application/octet-stream");
    expect(record.bytes).toBe(10);
  });

  it("0.1.0 までに保存された Blob 形式のレコードも読める", async () => {
    // 版を上げる前に写真を預けたまま更新した端末が、送信前に中身を失わないこと
    const legacy = {
      id: blobKey("job-old", "att-old"),
      jobId: "job-old",
      attachmentId: "att-old",
      blob: photo(800),
      bytes: 800,
    } as unknown as StoredBlob;
    await db.put("blobs", legacy);

    const restored = await getBlob(db, "job-old", "att-old");
    expect(restored!.size).toBe(800);
    expect(fromStoredBlob(legacy).size).toBe(800);
  });
});
