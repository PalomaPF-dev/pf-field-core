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

  /**
   * このジョブを送るための認証ヘッダ。
   *
   * トークンはキュー側が持つ（`tokens` ストア。`list()` には乗らない）ので、
   * ランナーは中身を知らずにヘッダだけ受け取る。
   */
  authHeaders(): Promise<JobAuthHeaders>;

  /** 添付の実体を取り出す */
  attachmentBlob(attachmentId: string): Promise<Blob | undefined>;

  /**
   * ジョブを DB から読み直す。
   * `onAttachmentUploaded` で書いた ref を、送信直前に取り直すために使う。
   */
  reloadJob?(): Promise<QueueJob | undefined>;

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

/** 送信時に付けるヘッダと、トークンが取れたかどうか。 */
export interface JobAuthHeaders {
  headers: Record<string, string>;
  /**
   * トークンを使う構成なのに取り出せなかった（期限切れ・端末から消えた）。
   *
   * true なら、通信する前に auth エラーへ倒してよい。投げても 401 になるだけで、
   * 弱電界では無駄な往復が数十秒の「送信中」に化ける。
   */
  tokenMissing: boolean;
}
