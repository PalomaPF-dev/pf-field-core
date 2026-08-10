import type { StoredObjectRef } from "../storage/types.js";
import type { QueueError, QueueJob, QueueJobPhase, QueueJobProgress } from "./types.js";

/**
 * 送信ランナーの実体。キューと通信を分ける継ぎ目。
 *
 * キュー側（M2）が持つのは、永続化・状態遷移・実行順・バックオフ・排他。
 * 通信のやり方（署名付きURLの取得、アップロード、レコード送信）は
 * こちら側（M3）が持つ。
 *
 * この分割のおかげで、キューの正しさは通信を1バイトも発生させずに検証できる。
 */
export interface JobProcessor {
  process(job: QueueJob, ctx: ProcessContext): Promise<ProcessOutcome>;
}

export interface ProcessContext {
  /** ジョブが中止されたら発火する */
  signal: AbortSignal;

  /** 添付の実体を取り出す */
  attachmentBlob(attachmentId: string): Promise<Blob | undefined>;

  /**
   * 添付1件のアップロード完了を記録する。
   * **1件ごとに呼ぶこと。** 3枚中2枚まで送った時点で圏外になっても、
   * 次回は残り1枚だけを送れるようにするための記録。
   */
  onAttachmentUploaded(attachmentId: string, ref: StoredObjectRef): Promise<void>;

  onProgress(progress: Partial<QueueJobProgress>): Promise<void>;
  setPhase(phase: QueueJobPhase): Promise<void>;
}

export type ProcessOutcome =
  | { ok: true; serverId?: string; duplicated?: boolean }
  | { ok: false; error: QueueError };
