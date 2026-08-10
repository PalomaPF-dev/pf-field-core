import { probeImageCapabilities } from "../image/capabilities.js";
import { ensurePersistence } from "../db/quota.js";
import type {
  CapabilityOverrides,
  FieldCapabilities,
  PlatformKind,
  ProbedCapabilities,
  SyncTrigger,
} from "./types.js";

function globalValue(name: string): unknown {
  return (globalThis as unknown as Record<string, unknown>)[name];
}

function isFunction(value: unknown): boolean {
  return typeof value === "function";
}

/**
 * 端末種別。
 *
 * iPadOS 13 以降の Safari は既定で「Macintosh」を名乗るので、UA だけでは
 * iPad を見分けられない。タッチ点数を併用する（デスクトップ Mac は 0）。
 */
export function detectPlatform(): PlatformKind {
  const nav = globalThis.navigator as Navigator | undefined;
  const ua = nav?.userAgent ?? "";
  if (!ua) return "other";

  if (/iPad|iPhone|iPod/.test(ua)) return "ios";
  if (ua.includes("Macintosh") && (nav?.maxTouchPoints ?? 0) > 1) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

function serviceWorkerRegistrationPrototype(): Record<string, unknown> | null {
  const ctor = globalValue("ServiceWorkerRegistration") as { prototype?: unknown } | undefined;
  if (typeof ctor !== "function") return null;
  const proto = (ctor as unknown as { prototype?: Record<string, unknown> }).prototype;
  return proto && typeof proto === "object" ? proto : null;
}

/**
 * 同期的に判る範囲の能力検出。
 *
 * 実際に呼んでみないと判らないもの（persist の許可、EXIF 向きの適用可否）は
 * `probeCapabilities()` で確かめる。
 */
export function detectCapabilities(overrides?: CapabilityOverrides): FieldCapabilities {
  const nav = globalThis.navigator as Navigator | undefined;
  const platform = overrides?.platform ?? detectPlatform();
  const swProto = serviceWorkerRegistrationPrototype();

  const serviceWorker = Boolean(nav && "serviceWorker" in nav);
  const backgroundSync = overrides?.backgroundSync ?? (swProto !== null && "sync" in swProto);
  const periodicBackgroundSync = swProto !== null && "periodicSync" in swProto;

  const storage = nav?.storage;

  // iOS には DataWedge が無い。機能検出では判らないので端末種別で決める
  const hardwareScanner = overrides?.hardwareScanner ?? platform !== "ios";

  return {
    platform,

    serviceWorker,
    backgroundSync,
    periodicBackgroundSync,
    requiresForegroundToSend: !backgroundSync,
    syncTriggers: syncTriggersFor(backgroundSync),

    indexedDB: typeof globalValue("indexedDB") !== "undefined",
    storageEstimate: isFunction(storage?.estimate),
    storagePersistence: isFunction(storage?.persist),
    webLocks: isFunction(nav?.locks?.request),

    offscreenCanvas: isFunction(globalValue("OffscreenCanvas")),
    createImageBitmap: isFunction(globalValue("createImageBitmap")),

    hardwareScanner,
  };
}

/**
 * 実際に働く送信のきっかけ。
 *
 * Background Sync が無い環境でも、以下のきっかけで送信は動く。
 * ここが空になることは無い ＝ **iOS でも送信されないわけではない**。
 * ただし「アプリを開いている間だけ」という制約が付く。
 */
export function syncTriggersFor(backgroundSync: boolean): SyncTrigger[] {
  const foreground: SyncTrigger[] = ["app-open", "visibility", "focus", "interval"];
  return backgroundSync ? ["background-sync", ...foreground] : foreground;
}

/**
 * 実際に呼び出して確かめる版。実機での採取と、初期化時の1回に使う。
 *
 * `storagePersisted` の取得には `navigator.storage.persist()` の呼び出しが伴う
 * （ブラウザによっては利用者への確認が出る）。副作用があるので、
 * 表示目的だけなら `detectCapabilities()` を使うこと。
 */
export async function probeCapabilities(
  overrides?: CapabilityOverrides,
): Promise<ProbedCapabilities> {
  const base = detectCapabilities(overrides);
  const image = await probeImageCapabilities();
  const storagePersisted = base.storagePersistence ? await ensurePersistence() : false;

  return {
    ...base,
    storagePersisted,
    imageOrientationFromImage: image.imageOrientationFromImage,
    webpEncode: image.webp,
  };
}

/**
 * 送信の制約を利用者向けの一文にする。
 * UI がそのまま出せる文言を、判定と一箇所で持つための関数。
 */
export function describeSyncBehaviour(capabilities: FieldCapabilities): string {
  if (capabilities.backgroundSync) {
    return "電波が戻ると、アプリを閉じていても自動で送信されます。";
  }
  return "この端末では、送信完了までアプリを開いたままにしてください（閉じると送信が止まります）。";
}
