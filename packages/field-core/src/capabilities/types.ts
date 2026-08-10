/**
 * 実行環境の能力。
 *
 * 現場端末は将来的に Zebra Android だが、当面は iPhone も併用する。
 * 両者は**送信の振る舞いが根本的に違う**:
 *
 *   Android Chrome — Background Sync が使える。アプリを閉じても送信される
 *   iOS Safari     — Background Sync が無い。アプリを開いている間しか送信されない
 *
 * この差は利用者に見える差なので、UI が出し分けられるように公開する。
 * 「送信が終わるまでアプリを開いたままにしてください」を出すかどうかの判断は、
 * `requiresForegroundToSend` を見て決める。
 */

export type PlatformKind = "android" | "ios" | "other";

/**
 * 送信のきっかけ。UI の説明文をこの配列から組み立てられる。
 * 例: 「アプリを前面に戻したとき」「1分ごと」
 */
export type SyncTrigger =
  /** アプリを閉じていても送られる（Background Sync）*/
  | "background-sync"
  /** アプリを開いたとき */
  | "app-open"
  /** 前面に戻したとき */
  | "visibility"
  /** ウィンドウがフォーカスされたとき */
  | "focus"
  /** 開いている間の定期実行 */
  | "interval";

export interface FieldCapabilities {
  /**
   * 実行環境の種別。
   * **機能判定で決められることは機能判定で決めること。** これは
   * 「ハードウェアスキャナがありうるか」のような、機能検出では判らない
   * 判断にだけ使う最後の手段。
   */
  platform: PlatformKind;

  // ---- 送信 ----

  serviceWorker: boolean;
  /**
   * Background Sync が使えるか。
   * **iOS Safari では false。** このとき送信はアプリを開いている間だけ動く。
   */
  backgroundSync: boolean;
  /** Periodic Background Sync。条件が厳しいのであてにしない */
  periodicBackgroundSync: boolean;
  /**
   * 送信が終わるまでアプリを開いたままにする必要があるか（= !backgroundSync）。
   * UI に注意書きを出す条件はこれ。
   */
  requiresForegroundToSend: boolean;
  /** 実際に働く送信のきっかけ。UI の説明文に使える */
  syncTriggers: SyncTrigger[];

  // ---- ストレージ ----

  indexedDB: boolean;
  /** navigator.storage.estimate() が使えるか。false だと残量が判らない */
  storageEstimate: boolean;
  /** navigator.storage.persist() を呼べるか（許可されたかは別。probe で確認する）*/
  storagePersistence: boolean;
  webLocks: boolean;

  // ---- 画像 ----

  offscreenCanvas: boolean;
  createImageBitmap: boolean;

  // ---- 入力 ----

  /**
   * ハードウェアスキャナ（DataWedge のキーボードエミュレーション）からの
   * 入力を期待してよいか。
   *
   * **iOS では false。** アプリは手入力の UI にフォールバックする。
   * 機能検出では判らないので端末種別で決めている。誤判定したときのために
   * `detectCapabilities({ hardwareScanner: true })` で上書きできる。
   */
  hardwareScanner: boolean;
}

/** 実際に呼んでみないと判らないものを含めた版。 */
export interface ProbedCapabilities extends FieldCapabilities {
  /** navigator.storage.persist() が**許可された**か */
  storagePersisted: boolean;
  /** createImageBitmap(blob, { imageOrientation: 'from-image' }) が通るか */
  imageOrientationFromImage: boolean;
  /** canvas から WebP を書き出せるか */
  webpEncode: boolean;
}

export interface CapabilityOverrides {
  platform?: PlatformKind;
  hardwareScanner?: boolean;
  backgroundSync?: boolean;
}
