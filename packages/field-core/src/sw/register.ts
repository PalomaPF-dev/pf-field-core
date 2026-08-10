import { detectCapabilities } from "../capabilities/detect.js";

/**
 * 画面側から Service Worker を扱う。**ページ側専用**（SW の中では使わない）。
 *
 * Background Sync は Android Chrome にはあり、**iOS Safari には無い**。
 * ここでは「無ければ諦める」ではなく、**無いことを呼び出し側に返す**。
 * UI は `capabilities.backgroundSync` を見て
 * 「送信完了までアプリを開いたままにしてください」を出せる。
 */

export interface RegisterOptions {
  /** SW のパス。既定 '/sw.js' */
  url?: string;
  scope?: string;
  /** 更新が見つかったときに呼ばれる */
  onUpdateFound?: (registration: ServiceWorkerRegistration) => void;
}

export interface RegisterResult {
  registration: ServiceWorkerRegistration | null;
  /** 登録できなかった理由。SW 非対応・HTTPS でない・登録失敗 */
  reason?: "unsupported" | "insecure" | "failed";
  error?: Error;
}

export async function registerFieldServiceWorker(
  options?: RegisterOptions,
): Promise<RegisterResult> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return { registration: null, reason: "unsupported" };
  }
  // localhost は例外的に安全な文脈として扱われる
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return { registration: null, reason: "insecure" };
  }

  try {
    const registration = await navigator.serviceWorker.register(options?.url ?? "/sw.js", {
      ...(options?.scope ? { scope: options.scope } : {}),
    });

    registration.addEventListener("updatefound", () => {
      options?.onUpdateFound?.(registration);
    });

    return { registration };
  } catch (error) {
    return {
      registration: null,
      reason: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export interface SyncRequestResult {
  /** Background Sync に登録できたか */
  registered: boolean;
  /**
   * 送信を画面が開いている間に頼るしかないか。
   * iOS はここが true になる。UI はこの値で文言を出し分ける。
   */
  requiresForeground: boolean;
  reason?: "unsupported" | "no-registration" | "failed";
}

/**
 * 「あとで送っておいて」を Service Worker に頼む。
 *
 * **iOS では登録できない。** その場合 `requiresForeground: true` を返すので、
 * 呼び出し側は画面側のトリガ（visibilitychange / focus / pageshow / 定期実行）に任せる。
 * これは劣化ではなく、iOS で取りうる唯一の経路。
 */
export async function requestQueueSync(
  tag = "pf-field-queue",
  registration?: ServiceWorkerRegistration | null,
): Promise<SyncRequestResult> {
  const capabilities = detectCapabilities();

  if (!capabilities.backgroundSync) {
    return { registered: false, requiresForeground: true, reason: "unsupported" };
  }

  const target =
    registration ??
    (typeof navigator !== "undefined" && "serviceWorker" in navigator
      ? await navigator.serviceWorker.ready
      : null);

  if (!target) {
    return { registered: false, requiresForeground: true, reason: "no-registration" };
  }

  try {
    const sync = (target as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } })
      .sync;
    if (!sync) {
      return { registered: false, requiresForeground: true, reason: "unsupported" };
    }
    await sync.register(tag);
    return { registered: true, requiresForeground: false };
  } catch {
    // 登録上限に達した等。送れなくなるわけではないので前面送信に倒す
    return { registered: false, requiresForeground: true, reason: "failed" };
  }
}

/** 開いている Service Worker に「いま送って」と伝える */
export function askServiceWorkerToFlush(): boolean {
  if (typeof navigator === "undefined" || !navigator.serviceWorker?.controller) return false;
  navigator.serviceWorker.controller.postMessage({ type: "pf-field-flush" });
  return true;
}
