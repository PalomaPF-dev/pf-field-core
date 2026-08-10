import type { StoredObjectRef } from "../storage/types.js";

/**
 * マスタのローカルキャッシュ（M6）。
 *
 * 目的は「圏外で点検を新規に開始できる」こと。
 * 未送信ジョブ（端末にしか無いデータ）とは性質が違い、**いつでも取り直せる**。
 * だから容量が苦しくなったら遠慮なく捨ててよい — その判断がキュー側と逆になる。
 */

/** 一覧系マスタ。件数が少ないので差分ではなく全置換で更新する */
export interface MasterCollectionInput<T = unknown> {
  collection: string;
  items: T[];
  /** サーバ側の版。変われば置き換える。省略時は毎回置き換える */
  version?: string;
}

export interface MasterCollection<T = unknown> extends MasterCollectionInput<T> {
  /** 会社・工場のスコープ。**取得範囲を絞るのは容量のためだけではない** */
  scope: string;
  fetchedAt: number;
}

/**
 * メディア（正常見本・図面ピンの画像）の在り処。
 *
 * **`state` を見て UI を出し分けるための型。**
 * とくに `unavailable` は「いまは出せないが、オンラインなら出せる」という意味で、
 * 画面には「オンライン時に表示されます」と出す。
 * 「読み込み失敗」や「画像がありません」と出すと、現場では別の問題に見えてしまう。
 */
export type MediaAvailability =
  /** 端末にある。圏外でも表示できる */
  | { state: "cached"; url: string; bytes: number; contentType: string }
  /** 端末には無いが、いまは取りに行ける */
  | { state: "online"; url: string }
  /** 端末に無く、いまは取りに行けない → 「オンライン時に表示されます」 */
  | { state: "unavailable"; reason: "offline" | "not-prefetched" }
  | { state: "loading" };

export interface PrefetchRequest {
  /**
   * まとめて捨てるための括り。点検表IDや設備IDを使う。
   * 次の点検に移ったら前の分をまとめて片付けられる。
   */
  groupId: string;
  refs: StoredObjectRef[];
}

export interface PrefetchResult {
  groupId: string;
  /** 新たに端末へ入れた数 */
  fetched: number;
  /** 既に端末にあった数 */
  reused: number;
  /** 取れなかった数（圏外・失効など）。0 でなくても点検は開始できる */
  failed: number;
  bytes: number;
}

export interface MasterCacheStats {
  collections: { collection: string; items: number; fetchedAt: number }[];
  assets: { count: number; bytes: number; groups: number };
}

export interface MasterCacheLimits {
  /**
   * メディアの上限。既定 60MB。
   *
   * **未送信ジョブの滞留上限とは別枠**。マスタは取り直せるので、
   * ここを未送信の容量計算に混ぜると「あと何枚撮れるか」が読めなくなる。
   */
  maxAssetBytes: number;
  /** 1つの括りあたりの上限。図面1枚で埋め尽くされないように */
  maxAssetsPerGroup: number;
}

export const DEFAULT_MASTER_LIMITS: Readonly<MasterCacheLimits> = Object.freeze({
  maxAssetBytes: 60 * 1024 * 1024,
  maxAssetsPerGroup: 50,
});
