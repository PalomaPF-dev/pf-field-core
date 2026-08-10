import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeSyncBehaviour,
  detectCapabilities,
  detectPlatform,
  syncTriggersFor,
} from "../src/capabilities/detect.js";

/**
 * 端末能力の判定。
 *
 * Android と iOS で送信の振る舞いが根本的に違う（Background Sync の有無）。
 * ここの判定を UI がそのまま使うので、誤ると
 * 「iPhone なのに『閉じても送信されます』と表示する」ことになる。
 */

/** 与えた条件のブラウザに見せかける */
function stubEnvironment(options: {
  userAgent?: string;
  maxTouchPoints?: number;
  serviceWorker?: boolean;
  backgroundSync?: boolean;
  periodicSync?: boolean;
  storage?: boolean;
  locks?: boolean;
  offscreenCanvas?: boolean;
  createImageBitmap?: boolean;
  indexedDB?: boolean;
}) {
  const proto: Record<string, unknown> = {};
  if (options.backgroundSync) proto["sync"] = {};
  if (options.periodicSync) proto["periodicSync"] = {};

  if (options.serviceWorker === false) {
    vi.stubGlobal("ServiceWorkerRegistration", undefined);
  } else {
    const ctor = function ServiceWorkerRegistration() {};
    ctor.prototype = proto;
    vi.stubGlobal("ServiceWorkerRegistration", ctor);
  }

  const navigator: Record<string, unknown> = {
    userAgent: options.userAgent ?? "",
    maxTouchPoints: options.maxTouchPoints ?? 0,
  };
  if (options.serviceWorker !== false) navigator["serviceWorker"] = {};
  if (options.storage !== false) {
    navigator["storage"] = { estimate: () => {}, persist: () => {}, persisted: () => {} };
  }
  if (options.locks !== false) navigator["locks"] = { request: () => {} };

  vi.stubGlobal("navigator", navigator);
  vi.stubGlobal("OffscreenCanvas", options.offscreenCanvas === false ? undefined : class {});
  vi.stubGlobal(
    "createImageBitmap",
    options.createImageBitmap === false ? undefined : () => Promise.resolve({}),
  );
  vi.stubGlobal("indexedDB", options.indexedDB === false ? undefined : {});
}

const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 11; TC26) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectPlatform", () => {
  it("Zebra の Android を android と判定する", () => {
    stubEnvironment({ userAgent: ANDROID_CHROME });
    expect(detectPlatform()).toBe("android");
  });

  it("iPhone を ios と判定する", () => {
    stubEnvironment({ userAgent: IPHONE_SAFARI });
    expect(detectPlatform()).toBe("ios");
  });

  it("iPad を ios と判定する（Macintosh を名乗る）", () => {
    // iPadOS 13 以降の Safari は既定で Mac を名乗る。タッチ点数で見分ける
    stubEnvironment({ userAgent: IPAD_SAFARI, maxTouchPoints: 5 });
    expect(detectPlatform()).toBe("ios");
  });

  it("デスクトップ Mac は ios にしない", () => {
    stubEnvironment({ userAgent: IPAD_SAFARI, maxTouchPoints: 0 });
    expect(detectPlatform()).toBe("other");
  });
});

describe("Background Sync の可否", () => {
  it("Android Chrome では使える", () => {
    stubEnvironment({ userAgent: ANDROID_CHROME, backgroundSync: true });
    const caps = detectCapabilities();

    expect(caps.backgroundSync).toBe(true);
    expect(caps.requiresForegroundToSend).toBe(false);
    expect(caps.syncTriggers).toContain("background-sync");
  });

  it("iOS Safari では使えない", () => {
    stubEnvironment({ userAgent: IPHONE_SAFARI, backgroundSync: false });
    const caps = detectCapabilities();

    expect(caps.backgroundSync).toBe(false);
    // UI が「開いたままにしてください」を出す条件
    expect(caps.requiresForegroundToSend).toBe(true);
  });

  it("Background Sync が無くても送信のきっかけは残る", () => {
    // 「iOS では送信されない」ではない。開いている間は送られる
    stubEnvironment({ userAgent: IPHONE_SAFARI, backgroundSync: false });
    const caps = detectCapabilities();

    expect(caps.syncTriggers).not.toContain("background-sync");
    expect(caps.syncTriggers).toEqual(["app-open", "visibility", "focus", "interval"]);
    expect(caps.syncTriggers.length).toBeGreaterThan(0);
  });

  it("Service Worker ごと無い環境でも判定できる", () => {
    stubEnvironment({ userAgent: IPHONE_SAFARI, serviceWorker: false });
    const caps = detectCapabilities();

    expect(caps.serviceWorker).toBe(false);
    expect(caps.backgroundSync).toBe(false);
    expect(caps.requiresForegroundToSend).toBe(true);
  });

  it("Periodic Background Sync は別に判定する", () => {
    stubEnvironment({ userAgent: ANDROID_CHROME, backgroundSync: true, periodicSync: false });
    expect(detectCapabilities().periodicBackgroundSync).toBe(false);

    stubEnvironment({ userAgent: ANDROID_CHROME, backgroundSync: true, periodicSync: true });
    expect(detectCapabilities().periodicBackgroundSync).toBe(true);
  });
});

describe("ハードウェアスキャナ", () => {
  it("iOS では期待しない（手入力にフォールバックさせる）", () => {
    // DataWedge は Zebra 専用。iOS には無い
    stubEnvironment({ userAgent: IPHONE_SAFARI });
    expect(detectCapabilities().hardwareScanner).toBe(false);
  });

  it("Android では期待してよい", () => {
    stubEnvironment({ userAgent: ANDROID_CHROME });
    expect(detectCapabilities().hardwareScanner).toBe(true);
  });

  it("誤判定に備えて上書きできる", () => {
    stubEnvironment({ userAgent: IPHONE_SAFARI });
    expect(detectCapabilities({ hardwareScanner: true }).hardwareScanner).toBe(true);

    stubEnvironment({ userAgent: ANDROID_CHROME });
    expect(detectCapabilities({ hardwareScanner: false }).hardwareScanner).toBe(false);
  });
});

describe("ストレージ関連の判定", () => {
  it("使える環境を正しく拾う", () => {
    stubEnvironment({ userAgent: ANDROID_CHROME });
    const caps = detectCapabilities();

    expect(caps.indexedDB).toBe(true);
    expect(caps.storageEstimate).toBe(true);
    expect(caps.storagePersistence).toBe(true);
    expect(caps.webLocks).toBe(true);
  });

  it("navigator.storage が無い環境を拾う", () => {
    stubEnvironment({ userAgent: IPHONE_SAFARI, storage: false, locks: false });
    const caps = detectCapabilities();

    expect(caps.storageEstimate).toBe(false);
    expect(caps.storagePersistence).toBe(false);
    expect(caps.webLocks).toBe(false);
  });
});

describe("syncTriggersFor", () => {
  it("Background Sync がある場合は先頭に来る", () => {
    expect(syncTriggersFor(true)[0]).toBe("background-sync");
  });

  it("無い場合も空にはならない", () => {
    expect(syncTriggersFor(false).length).toBeGreaterThan(0);
  });
});

describe("describeSyncBehaviour", () => {
  it("Background Sync があれば「閉じていても送信される」", () => {
    stubEnvironment({ userAgent: ANDROID_CHROME, backgroundSync: true });
    expect(describeSyncBehaviour(detectCapabilities())).toMatch(/閉じていても/);
  });

  it("無ければ「開いたままにしてください」", () => {
    stubEnvironment({ userAgent: IPHONE_SAFARI, backgroundSync: false });
    const text = describeSyncBehaviour(detectCapabilities());
    expect(text).toMatch(/開いたまま/);
    expect(text).not.toMatch(/閉じていても/);
  });
});

describe("何も無い環境", () => {
  it("例外を投げず、すべて false で返す", () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("ServiceWorkerRegistration", undefined);
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("OffscreenCanvas", undefined);
    vi.stubGlobal("createImageBitmap", undefined);

    const caps = detectCapabilities();
    expect(caps.platform).toBe("other");
    expect(caps.serviceWorker).toBe(false);
    expect(caps.backgroundSync).toBe(false);
    expect(caps.indexedDB).toBe(false);
    expect(caps.requiresForegroundToSend).toBe(true);
  });
});
