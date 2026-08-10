import { describe, expect, it } from "vitest";
import type { StoredJob } from "../src/db/schema.js";
import type { QueueError, QueueJobStatus } from "../src/queue/types.js";
import {
  canTransition,
  InvalidTransitionError,
  isTerminal,
  markActive,
  markAttachmentUploaded,
  markCanceled,
  markFailed,
  markForRetry,
  markSucceeded,
  pendingAttachments,
  releaseToPending,
} from "../src/queue/state.js";

const ALL: QueueJobStatus[] = ["pending", "active", "succeeded", "failed", "blocked", "canceled"];

function job(overrides?: Partial<StoredJob>): StoredJob {
  return {
    jobId: "job-1",
    type: "setsubi.inspection",
    status: "pending",
    payload: {},
    attachments: [],
    attempts: 0,
    maxAttempts: 10,
    priority: 0,
    nextAttemptAt: null,
    progress: { uploadedBytes: 0, totalBytes: 0, uploadedCount: 0, totalCount: 0 },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

const retryable: QueueError = {
  kind: "network",
  retryable: true,
  message: "圏外",
  at: 2_000,
};
const permanent: QueueError = {
  kind: "auth",
  retryable: false,
  message: "認証が切れています",
  at: 2_000,
};

describe("遷移表", () => {
  /**
   * 全 36 通りを表で押さえる。ここが緩むと
   * 「送信済みのジョブがもう一度送られる」「取り消したはずが復活する」が起きる。
   */
  const allowed: Record<QueueJobStatus, QueueJobStatus[]> = {
    pending: ["active", "canceled"],
    active: ["succeeded", "pending", "failed", "blocked", "canceled"],
    succeeded: [],
    failed: ["pending", "canceled"],
    blocked: ["pending", "canceled"],
    canceled: [],
  };

  for (const from of ALL) {
    for (const to of ALL) {
      const expected = allowed[from].includes(to);
      it(`${from} → ${to} は ${expected ? "許可" : "禁止"}`, () => {
        expect(canTransition(from, to)).toBe(expected);
      });
    }
  }

  it("succeeded と canceled は終端", () => {
    expect(isTerminal("succeeded")).toBe(true);
    expect(isTerminal("canceled")).toBe(true);
    expect(isTerminal("failed")).toBe(false);
    expect(isTerminal("blocked")).toBe(false);
  });
});

describe("markActive", () => {
  it("実行者と開始時刻を記録する", () => {
    const next = markActive(job(), "tab-a", 5_000);
    expect(next.status).toBe("active");
    expect(next.activeBy).toBe("tab-a");
    expect(next.activeSince).toBe(5_000);
    expect(next.phase).toBe("signing");
  });

  it("pending 以外からは開始できない", () => {
    expect(() => markActive(job({ status: "succeeded" }), "tab-a")).toThrow(InvalidTransitionError);
    expect(() => markActive(job({ status: "active" }), "tab-a")).toThrow(InvalidTransitionError);
  });
});

describe("markSucceeded", () => {
  it("実行中の痕跡を消し、進捗を満了にする", () => {
    const active = markActive(
      job({ progress: { uploadedBytes: 100, totalBytes: 300, uploadedCount: 1, totalCount: 3 } }),
      "tab-a",
    );
    const next = markSucceeded(active, 9_000);

    expect(next.status).toBe("succeeded");
    expect(next.succeededAt).toBe(9_000);
    expect(next.progress).toEqual({
      uploadedBytes: 300,
      totalBytes: 300,
      uploadedCount: 3,
      totalCount: 3,
    });
    expect(next.activeSince).toBeUndefined();
    expect(next.activeBy).toBeUndefined();
    expect(next.phase).toBeUndefined();
    expect(next.lastError).toBeUndefined();
  });

  it("直前のエラーを残さない", () => {
    const active = markActive(job({ lastError: retryable }), "tab-a");
    expect(markSucceeded(active).lastError).toBeUndefined();
  });
});

describe("markFailed", () => {
  it("待てば直る失敗は pending に戻し、次回時刻を入れる", () => {
    const active = markActive(job(), "tab-a");
    const { job: next, disposition } = markFailed(active, retryable, {
      at: 10_000,
      random: () => 1, // jitter を最大に固定
    });

    expect(disposition).toBe("retry");
    expect(next.status).toBe("pending");
    expect(next.attempts).toBe(1);
    expect(next.nextAttemptAt).toBe(12_000); // 10_000 + 2秒
    expect(next.lastError).toEqual(retryable);
  });

  it("人手が要る失敗は blocked にし、自動では二度と試さない", () => {
    const active = markActive(job(), "tab-a");
    const { job: next, disposition } = markFailed(active, permanent);

    expect(disposition).toBe("blocked");
    expect(next.status).toBe("blocked");
    expect(next.nextAttemptAt).toBeNull();
    // 待っても直らないので試行回数は増やさない
    expect(next.attempts).toBe(0);
  });

  it("試行回数の上限に達したら failed（手動再送で復帰できる）", () => {
    const active = markActive(job({ attempts: 9, maxAttempts: 10 }), "tab-a");
    const { job: next, disposition } = markFailed(active, retryable);

    expect(disposition).toBe("give-up");
    expect(next.status).toBe("failed");
    expect(next.attempts).toBe(10);
    expect(next.nextAttemptAt).toBeNull();
  });

  it("待ち時間は失敗のたびに伸びる", () => {
    const delays: number[] = [];
    let current = job();
    for (let i = 0; i < 5; i++) {
      const active = markActive(current, "tab-a");
      const { job: next } = markFailed(active, retryable, { at: 0, random: () => 1 });
      delays.push(next.nextAttemptAt as number);
      current = next;
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
  });

  it("実行中の痕跡を消す", () => {
    const active = markActive(job(), "tab-a");
    const { job: next } = markFailed(active, retryable);
    expect(next.activeSince).toBeUndefined();
    expect(next.activeBy).toBeUndefined();
    expect(next.phase).toBeUndefined();
  });
});

describe("releaseToPending", () => {
  it("試行回数を増やさずに pending へ戻す", () => {
    // 端末が落ちたのはサーバのせいでも通信のせいでもない。
    // ここで数えると、WebView が何度か kill されただけで failed に落ちる
    const active = markActive(job({ attempts: 3 }), "tab-a");
    const next = releaseToPending(active, 20_000);

    expect(next.status).toBe("pending");
    expect(next.attempts).toBe(3);
    expect(next.activeBy).toBeUndefined();
  });
});

describe("markForRetry", () => {
  it("failed から即時実行できる状態に戻す", () => {
    const next = markForRetry(job({ status: "failed", attempts: 10, nextAttemptAt: 99_999 }));
    expect(next.status).toBe("pending");
    // 利用者が明示的に押した以上、前回の履歴で待たせる理由がない
    expect(next.attempts).toBe(0);
    expect(next.nextAttemptAt).toBeNull();
  });

  it("blocked からも戻せる（再ログイン後の救済）", () => {
    const next = markForRetry(job({ status: "blocked", lastError: permanent }));
    expect(next.status).toBe("pending");
  });

  it("succeeded は戻せない（二重送信になる）", () => {
    expect(() => markForRetry(job({ status: "succeeded" }))).toThrow(InvalidTransitionError);
  });
});

describe("markCanceled", () => {
  it("pending / failed / blocked から取り消せる", () => {
    for (const status of ["pending", "failed", "blocked"] as const) {
      expect(markCanceled(job({ status })).status).toBe("canceled");
    }
  });

  it("送信済みは取り消せない", () => {
    expect(() => markCanceled(job({ status: "succeeded" }))).toThrow(InvalidTransitionError);
  });
});

describe("添付の進捗", () => {
  function withAttachments(): StoredJob {
    return job({
      attachments: [
        { attachmentId: "a", fileName: "1.jpg", contentType: "image/jpeg", bytes: 100, status: "pending" },
        { attachmentId: "b", fileName: "2.jpg", contentType: "image/jpeg", bytes: 200, status: "pending" },
        { attachmentId: "c", fileName: "3.jpg", contentType: "image/jpeg", bytes: 300, status: "pending" },
      ],
      progress: { uploadedBytes: 0, totalBytes: 600, uploadedCount: 0, totalCount: 3 },
    });
  }

  const ref = { provider: "supabase", bucket: "field-uploads", path: "x/y.jpg" };

  it("1件ごとに完了を記録し、進捗に反映する", () => {
    let current = withAttachments();
    current = markAttachmentUploaded(current, "a", ref, 3_000);

    expect(current.attachments[0]?.status).toBe("uploaded");
    expect(current.attachments[0]?.ref).toEqual(ref);
    expect(current.attachments[0]?.uploadedAt).toBe(3_000);
    expect(current.progress).toMatchObject({ uploadedCount: 1, uploadedBytes: 100 });

    current = markAttachmentUploaded(current, "c", ref, 4_000);
    expect(current.progress).toMatchObject({ uploadedCount: 2, uploadedBytes: 400 });
  });

  it("未送信の添付だけを次の対象にする", () => {
    // 3枚中2枚まで送った時点で圏外になっても、次回は残り1枚だけを送る
    let current = withAttachments();
    current = markAttachmentUploaded(current, "a", ref);
    current = markAttachmentUploaded(current, "b", ref);

    const remaining = pendingAttachments(current);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.attachmentId).toBe("c");
  });

  it("同じ添付を二度記録しても数が狂わない", () => {
    let current = withAttachments();
    current = markAttachmentUploaded(current, "a", ref);
    current = markAttachmentUploaded(current, "a", ref);
    expect(current.progress.uploadedCount).toBe(1);
    expect(current.progress.uploadedBytes).toBe(100);
  });
});
