import { FieldCoreError } from "../shared/errors.js";
import type { FieldDB } from "./open.js";
import { summarizeUnsent, type UnsentSummary } from "./jobs.repo.js";

/**
 * 端末ストレージの健康状態。
 *
 * Zebra 端末は空き容量が潤沢とは限らない。「入らなくなってから気づく」と
 * 現場では撮った写真がその場で失われるので、**入らなくなる前に**警告を出せるよう、
 * 端末の空き容量と滞留量の両方をひとまとめにして UI へ渡す。
 */
export interface StorageHealth {
  /** navigator.storage.estimate() の値。取得できない環境では null */
  usageBytes: number | null;
  quotaBytes: number | null;
  availableBytes: number | null;
  /** navigator.storage.persist() が許可されているか */
  persisted: boolean;
  /** navigator.storage.persist() を呼べる環境か */
  persistenceSupported: boolean;
  /**
   * 永続化に対応しているのに**拒否された**（iOS Safari では珍しくない）。
   *
   * この状態では、7日間サイトを開かないとブラウザが保存データを消す。
   * 未送信を長く抱えたままにできないので、UI は送信を促す必要がある。
   *
   * API ごと無い環境は「判らない」であって拒否ではないので false のままにする。
   */
  persistenceDenied: boolean;
  /** 消失を検知したか（db/eviction.ts）。検知は best-effort */
  evictionSuspected: boolean;
  /**
   * ok       — 余裕がある
   * warn     — 空きが warnBelowBytes 未満、または滞留が上限の8割を超えた
   * critical — これ以上 enqueue できない
   */
  level: "ok" | "warn" | "critical";
  /** critical / warn の理由（UI にそのまま出せる日本語） */
  reason: string | null;
  unsent: UnsentSummary;
}

export interface RetentionLimits {
  /** 成功したジョブを保持する期間。既定 7日 */
  succeededMaxAgeMs: number;
  /** 未送信ジョブの上限件数。超えたら enqueue を断る */
  maxUnsentJobs: number;
  /** 未送信の添付枚数の上限 */
  maxUnsentAttachments: number;
  /** 未送信の添付の合計バイト数の上限 */
  maxUnsentBytes: number;
  /** 未送信がこの期間を超えたら警告する */
  staleUnsentAfterMs: number;
}

export interface QuotaLimits {
  /** 空きがこれを下回ったら警告する */
  warnBelowBytes: number;
  /** 空きがこれを下回ったら enqueue を断る */
  blockBelowBytes: number;
}

/**
 * すべて**暫定値**。実機の実測が出るまでの見積りで、確定値ではない。
 *
 * ## どれが実際に効くか
 *
 * ここは `createOfflineQueue()` を直接呼んだときのフォールバック。
 * アプリが通る `createFieldCore()` は `DEFAULT_QUEUE_LIMITS` から算出した値で
 * 一部を**上書きする**ので、実際に効く値は次のように混ざる（core.ts 参照）:
 *
 * | 項目 | createFieldCore() 経由 | ここの値を直接使う場合 |
 * |---|---|---|
 * | `maxUnsentAttachments` | **200枚**（10枚/ジョブ × 20） | 300枚 |
 * | `maxUnsentBytes` | **160MB**（8MB/ジョブ × 20） | 120MB |
 * | `maxUnsentJobs` | 200件（上書きなし） | 200件 |
 * | `succeededMaxAgeMs` | 7日（上書きなし） | 7日 |
 *
 * 枚数と容量だけが食い違っているのは、算出の根拠が違うため。
 * ここは「200〜400KB × 300枚 ≒ 90MB に余裕を足して 120MB」という端末容量からの見積り、
 * core.ts 側は「1ジョブの上限 × 20ジョブぶん」という滞留量からの見積り。
 * どちらが正しいかは実機でないと決まらない。
 *
 * ## 確定のしかた
 *
 * pf-setsubi の Android 実機パイロットで、1枚あたりの実サイズと
 * 圏外がどれだけ続くかを測ってから、**両方を揃えて**確定する。
 * 片方だけ触ると再び食い違うので、直すときは core.ts の retention も同時に見ること。
 */
export const DEFAULT_RETENTION: RetentionLimits = {
  succeededMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxUnsentJobs: 200,
  maxUnsentAttachments: 300,
  maxUnsentBytes: 120 * 1024 * 1024,
  staleUnsentAfterMs: 3 * 24 * 60 * 60 * 1000,
};

export const DEFAULT_QUOTA: QuotaLimits = {
  warnBelowBytes: 50 * 1024 * 1024,
  blockBelowBytes: 20 * 1024 * 1024,
};

/**
 * ストレージの永続化を要求する。
 *
 * 許可されないと、端末の空きが減ったときにブラウザが黙って IndexedDB を捨てる。
 * 未送信の点検結果が消えるということなので、初期化時に必ず要求する。
 * Android Chrome では PWA としてインストールされているか等の条件で自動判定され、
 * 拒否されることもある。拒否されても動作は続ける（保証が下がるだけ）。
 */
export async function ensurePersistence(): Promise<boolean> {
  const storage = globalThis.navigator?.storage;
  if (!storage) return false;
  try {
    if (typeof storage.persisted === "function" && (await storage.persisted())) return true;
    if (typeof storage.persist === "function") return await storage.persist();
  } catch {
    // 取得できない環境では「保証なし」として扱う
  }
  return false;
}

export interface StorageEstimate {
  usageBytes: number | null;
  quotaBytes: number | null;
  availableBytes: number | null;
}

export async function estimateStorage(): Promise<StorageEstimate> {
  const storage = globalThis.navigator?.storage;
  if (!storage || typeof storage.estimate !== "function") {
    return { usageBytes: null, quotaBytes: null, availableBytes: null };
  }
  try {
    const { usage, quota } = await storage.estimate();
    const usageBytes = usage ?? null;
    const quotaBytes = quota ?? null;
    return {
      usageBytes,
      quotaBytes,
      availableBytes: usageBytes !== null && quotaBytes !== null ? quotaBytes - usageBytes : null,
    };
  } catch {
    return { usageBytes: null, quotaBytes: null, availableBytes: null };
  }
}

export async function getStorageHealth(
  db: FieldDB,
  limits: { quota: QuotaLimits; retention: RetentionLimits },
  options?: { persisted?: boolean; evictionSuspected?: boolean },
): Promise<StorageHealth> {
  const estimate = await estimateStorage();
  const unsent = await summarizeUnsent(db);
  const persisted = options?.persisted ?? false;
  const evictionSuspected = options?.evictionSuspected ?? false;
  const persistenceSupported =
    typeof globalThis.navigator?.storage?.persist === "function";
  const persistenceDenied = persistenceSupported && !persisted;

  let { level, reason } = evaluate(estimate, unsent, limits);

  // 永続化が拒否されていて未送信を抱えているのは、iOS では実害のある状態。
  // 容量にはまだ余裕があっても「早く送ってください」と伝える必要がある
  if (level === "ok" && persistenceDenied && unsent.jobs > 0) {
    level = "warn";
    reason =
      "この端末では保存が保証されていません。未送信のデータは、しばらく使わないと" +
      "ブラウザに消される場合があります。電波の届く場所で早めに送信してください。";
  }

  return {
    ...estimate,
    persisted,
    persistenceSupported,
    persistenceDenied,
    evictionSuspected,
    level,
    reason,
    unsent,
  };
}

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function evaluate(
  estimate: StorageEstimate,
  unsent: UnsentSummary,
  limits: { quota: QuotaLimits; retention: RetentionLimits },
): { level: StorageHealth["level"]; reason: string | null } {
  const { quota, retention } = limits;

  // 端末の空き容量（estimate が取れない環境では判定しない）
  if (estimate.availableBytes !== null) {
    if (estimate.availableBytes < quota.blockBelowBytes) {
      return {
        level: "critical",
        reason: `端末の空き容量が足りません（残り ${mb(estimate.availableBytes)}）。未送信のデータを送信してください`,
      };
    }
  }

  // 滞留の上限
  if (unsent.jobs >= retention.maxUnsentJobs) {
    return {
      level: "critical",
      reason: `未送信が上限（${retention.maxUnsentJobs} 件）に達しています。電波の届く場所で送信してください`,
    };
  }
  if (unsent.attachments >= retention.maxUnsentAttachments) {
    return {
      level: "critical",
      reason: `未送信の写真が上限（${retention.maxUnsentAttachments} 枚）に達しています。電波の届く場所で送信してください`,
    };
  }
  if (unsent.bytes >= retention.maxUnsentBytes) {
    return {
      level: "critical",
      reason: `未送信のデータ量が上限（${mb(retention.maxUnsentBytes)}）に達しています。電波の届く場所で送信してください`,
    };
  }

  if (estimate.availableBytes !== null && estimate.availableBytes < quota.warnBelowBytes) {
    return {
      level: "warn",
      reason: `端末の空き容量が少なくなっています（残り ${mb(estimate.availableBytes)}）`,
    };
  }
  if (unsent.jobs >= retention.maxUnsentJobs * 0.8) {
    return {
      level: "warn",
      reason: `未送信が ${unsent.jobs} 件たまっています（上限 ${retention.maxUnsentJobs} 件）`,
    };
  }
  if (unsent.bytes >= retention.maxUnsentBytes * 0.8) {
    return {
      level: "warn",
      reason: `未送信のデータ量が ${mb(unsent.bytes)} になっています（上限 ${mb(retention.maxUnsentBytes)}）`,
    };
  }

  return { level: "ok", reason: null };
}

/**
 * これから追加する分を含めて容量が足りるかを確かめる。足りなければ例外を投げる。
 *
 * **黙って捨てない**のが要点。撮った写真が入らないなら、その場で利用者に伝える。
 * 後から気づいても、その写真はもう撮り直せない。
 */
export function assertCanEnqueue(
  health: StorageHealth,
  incoming: { attachments: number; bytes: number },
  limits: { quota: QuotaLimits; retention: RetentionLimits },
): void {
  if (health.level === "critical") {
    throw new FieldCoreError("quota_exceeded", health.reason ?? "端末に保存できません");
  }

  const { quota, retention } = limits;
  const projectedJobs = health.unsent.jobs + 1;
  const projectedAttachments = health.unsent.attachments + incoming.attachments;
  const projectedBytes = health.unsent.bytes + incoming.bytes;

  if (projectedJobs > retention.maxUnsentJobs) {
    throw new FieldCoreError(
      "quota_exceeded",
      `未送信が上限（${retention.maxUnsentJobs} 件）を超えるため保存できません。電波の届く場所で送信してください`,
    );
  }
  if (projectedAttachments > retention.maxUnsentAttachments) {
    throw new FieldCoreError(
      "quota_exceeded",
      `未送信の写真が上限（${retention.maxUnsentAttachments} 枚）を超えるため保存できません`,
    );
  }
  if (projectedBytes > retention.maxUnsentBytes) {
    throw new FieldCoreError(
      "quota_exceeded",
      `未送信のデータ量が上限（${mb(retention.maxUnsentBytes)}）を超えるため保存できません`,
    );
  }
  if (
    health.availableBytes !== null &&
    health.availableBytes - incoming.bytes < quota.blockBelowBytes
  ) {
    throw new FieldCoreError(
      "quota_exceeded",
      `端末の空き容量が足りません（残り ${mb(health.availableBytes)}）。未送信のデータを送信してください`,
    );
  }
}
