import type { AdapterContext, StoredObjectRef } from "../storage/types.js";
import type { QueueJob } from "../queue/types.js";

export interface SubmitResult {
  ok: true;
  /** サーバ側で採番された ID */
  serverId?: string;
  /** サーバ側で「既に受け付け済み」と判定された（冪等キーによる重複排除） */
  duplicated?: boolean;
}

/**
 * レコード本体の送信先の抽象。
 *
 * 現行は各アプリの Next.js Route Handler へ POST する（httpSubmitAdapter）。
 * DB を Supabase へ移したあとは Postgres 関数を1本呼ぶだけにできるので、
 * 差し替えられるようにここで切っておく。
 */
export interface SubmitAdapter {
  readonly name: string;
  send(job: QueueJob, refs: StoredObjectRef[], ctx: AdapterContext): Promise<SubmitResult>;
}

/** 冪等キーを載せるヘッダ名。サーバ側と合わせること。 */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
