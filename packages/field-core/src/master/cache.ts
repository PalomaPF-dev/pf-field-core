import { openFieldDB, type FieldDB } from "../db/open.js";
import { createEmitter } from "../shared/emitter.js";
import { defaultDbName, type StoredAsset, type StoredMaster } from "../db/schema.js";
import { safeFetch } from "../net/fetch-safe.js";
import { now } from "../shared/clock.js";
import { noopLogger, type FieldLogger } from "../shared/logger.js";
import { refKey, type FileUrlResolver, type StoredObjectRef } from "../storage/types.js";
import {
  DEFAULT_MASTER_LIMITS,
  type MasterCacheLimits,
  type MasterCacheStats,
  type MasterCollectionInput,
  type MediaAvailability,
  type PrefetchRequest,
  type PrefetchResult,
} from "./types.js";

/**
 * マスタのローカルキャッシュ。
 *
 * ## 一覧系（設備台帳・点検表・職場）
 * 件数が少ないので**全置換**。差分同期の複雑さに見合わない。
 * 更新は起動時とオンライン復帰時。
 *
 * ## メディア（正常見本・図面ピン）
 * **点検を開始する時に、その点検のぶんだけ先読みする。**
 * 全設備ぶんを事前に持つと容量が持たない。
 *
 * ## キューとの違い
 * 未送信ジョブは端末にしか無いので絶対に消せない。
 * マスタは**いつでも取り直せる**ので、容量が苦しければ遠慮なく捨てる。
 * この判断が逆になっているのが要点で、容量の枠も別に持つ。
 */

export interface MasterCacheOptions {
  appId: string;
  dbName?: string;
  db?: FieldDB;

  /**
   * 会社・工場のスコープ。**取得範囲を絞るのは容量のためだけではない。**
   * 全社分を端末に置くと、テナント分離が端末の中で崩れる。
   */
  scope: string;

  /** 一覧系マスタの取得。起動時とオンライン復帰時に呼ばれる */
  fetchCollections?: (scope: string) => Promise<MasterCollectionInput[]>;

  /** メディアの閲覧URLを解決する。省略時は ref.path をそのまま使う */
  urls?: FileUrlResolver;

  limits?: Partial<MasterCacheLimits>;
  logger?: FieldLogger;
}

export interface MasterCache {
  /**
   * 中身が変わったら呼ばれる。
   *
   * 起動時の取り直しは非同期なので、画面がその途中で開かれることがある。
   * これが無いと「一度読んで空だった」まま更新されず、
   * マスタがあるのに「未取得」と出続ける。
   */
  subscribe(listener: () => void): () => void;

  /** 一覧系を取り直す。オンラインでなければ何もしない */
  refresh(): Promise<{ updated: string[]; skipped: boolean }>;

  get<T>(collection: string): Promise<T[] | undefined>;
  put<T>(input: MasterCollectionInput<T>): Promise<void>;

  /** 点検開始時に、その点検のぶんだけ先読みする */
  prefetch(request: PrefetchRequest): Promise<PrefetchResult>;

  /**
   * メディアが今どう出せるかを返す。
   * **`unavailable` は「オンライン時に表示されます」と出すための状態。**
   */
  availability(ref: StoredObjectRef): Promise<MediaAvailability>;

  /** 端末にあるメディアを Blob で取り出す（無ければ undefined） */
  getAsset(ref: StoredObjectRef): Promise<Blob | undefined>;

  /** 括り単位で捨てる。次の点検に移ったときに前の分を片付ける */
  purgeGroup(groupId: string): Promise<number>;
  /** 全部捨てる。ログアウト時など */
  clear(): Promise<void>;

  stats(): Promise<MasterCacheStats>;
  destroy(): Promise<void>;
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export async function createMasterCache(options: MasterCacheOptions): Promise<MasterCache> {
  const db = options.db ?? (await openFieldDB(options.dbName ?? defaultDbName(options.appId)));
  const owned = !options.db;
  const limits: MasterCacheLimits = { ...DEFAULT_MASTER_LIMITS, ...options.limits };
  const logger = options.logger ?? noopLogger;

  const masterKey = (collection: string) => `${options.scope}:${collection}`;
  const emitter = createEmitter<{ change: void }>();
  const changed = () => emitter.emit("change", undefined);

  /**
   * 表示・取得に使う URL。
   *
   * `prefetch` と `availability` で必ず同じものを使うこと。
   * 片方だけ ref.path へフォールバックすると、オンラインなのに
   * 「オンライン時に表示されます」と出る食い違いが起きる。
   */
  async function mediaUrl(ref: StoredObjectRef): Promise<string | undefined> {
    if (options.urls) {
      try {
        return await options.urls.resolve(ref);
      } catch {
        // 署名が取れなくても、パスがそのまま使える構成はある
      }
    }
    return ref.path || undefined;
  }

  async function totalAssetBytes(): Promise<number> {
    const all = await db.getAll("assets");
    return all.reduce((sum, asset) => sum + asset.bytes, 0);
  }

  /**
   * 容量を空ける。**古い順に捨てる。**
   * ここで消せるのはマスタだけで、未送信ジョブの添付には決して触らない。
   */
  async function makeRoom(needBytes: number): Promise<void> {
    let total = await totalAssetBytes();
    if (total + needBytes <= limits.maxAssetBytes) return;

    const all = (await db.getAll("assets")).sort((a, b) => a.fetchedAt - b.fetchedAt);
    for (const asset of all) {
      if (total + needBytes <= limits.maxAssetBytes) break;
      await db.delete("assets", asset.key);
      total -= asset.bytes;
      logger.debug?.("容量確保のため先読み済みメディアを捨てました", { key: asset.key });
    }
  }

  return {
    subscribe(listener: () => void) {
      return emitter.on("change", listener);
    },

    async refresh() {
      if (!options.fetchCollections) return { updated: [], skipped: true };
      // 圏外で取りに行っても失敗するだけ。既にあるものを消さない
      if (!isOnline()) return { updated: [], skipped: true };

      let incoming: MasterCollectionInput[];
      try {
        incoming = await options.fetchCollections(options.scope);
      } catch (error) {
        // 取れなくても既存のキャッシュは保つ。圏外で点検を開始できることが優先
        logger.warn?.("マスタを取得できませんでした（既存のキャッシュは保持します）", {
          error: String(error),
        });
        return { updated: [], skipped: true };
      }

      const updated: string[] = [];
      for (const input of incoming) {
        const key = masterKey(input.collection);
        const existing = await db.get("masters", key);

        // 版が同じなら書き換えない（IndexedDB への無駄な書き込みを避ける）
        if (input.version !== undefined && existing?.version === input.version) continue;

        const record: StoredMaster = {
          key,
          collection: input.collection,
          scope: options.scope,
          items: input.items,
          ...(input.version !== undefined ? { version: input.version } : {}),
          fetchedAt: now(),
        };
        await db.put("masters", record);
        updated.push(input.collection);
      }

      if (updated.length > 0) changed();
      return { updated, skipped: false };
    },

    async get<T>(collection: string): Promise<T[] | undefined> {
      const record = await db.get("masters", masterKey(collection));
      return record ? (record.items as T[]) : undefined;
    },

    async put<T>(input: MasterCollectionInput<T>): Promise<void> {
      const record: StoredMaster = {
        key: masterKey(input.collection),
        collection: input.collection,
        scope: options.scope,
        items: input.items,
        ...(input.version !== undefined ? { version: input.version } : {}),
        fetchedAt: now(),
      };
      await db.put("masters", record);
      changed();
    },

    async prefetch(request: PrefetchRequest): Promise<PrefetchResult> {
      const result: PrefetchResult = {
        groupId: request.groupId,
        fetched: 0,
        reused: 0,
        failed: 0,
        bytes: 0,
      };

      const refs = request.refs.slice(0, limits.maxAssetsPerGroup);
      if (refs.length < request.refs.length) {
        logger.warn?.("先読みの上限に達したため一部を省きました", {
          requested: request.refs.length,
          limit: limits.maxAssetsPerGroup,
        });
      }

      for (const ref of refs) {
        const key = refKey(ref);
        if (await db.get("assets", key)) {
          result.reused++;
          continue;
        }
        if (!isOnline()) {
          result.failed++;
          continue;
        }

        try {
          const url = await mediaUrl(ref);
          if (!url) {
            result.failed++;
            continue;
          }
          const response = await safeFetch(url, { method: "GET", timeoutMs: 20_000 });
          if (response.status < 200 || response.status >= 300) {
            result.failed++;
            continue;
          }

          // Blob ではなくバイト列で持つ（WebKit で書き込みごと失敗するため）
          const data = await response.arrayBuffer();
          await makeRoom(data.byteLength);

          const asset: StoredAsset = {
            key,
            ref,
            data,
            contentType: response.headers?.get?.("content-type") ?? "application/octet-stream",
            bytes: data.byteLength,
            groupId: request.groupId,
            fetchedAt: now(),
          };
          await db.put("assets", asset);

          result.fetched++;
          result.bytes += data.byteLength;
        } catch (error) {
          // 1枚取れなくても点検は開始できる。落とさない
          result.failed++;
          logger.debug?.("メディアの先読みに失敗しました", { key, error: String(error) });
        }
      }

      if (result.fetched > 0) changed();
      return result;
    },

    async availability(ref: StoredObjectRef): Promise<MediaAvailability> {
      const asset = await db.get("assets", refKey(ref));
      if (asset) {
        const blob = new Blob([asset.data], { type: asset.contentType });
        return {
          state: "cached",
          url: URL.createObjectURL(blob),
          bytes: asset.bytes,
          contentType: asset.contentType,
        };
      }

      /*
       * 端末に無い。ここで返す状態が UI の文言を決める:
       *   online      … いま取りに行ける
       *   unavailable … 「オンライン時に表示されます」
       *
       * 「読み込み失敗」や「画像がありません」と出してはいけない。
       * 現場では別の問題（データの不備）に見えてしまう。
       */
      if (!isOnline()) return { state: "unavailable", reason: "offline" };

      const url = await mediaUrl(ref);
      if (!url) return { state: "unavailable", reason: "not-prefetched" };
      return { state: "online", url };
    },

    async getAsset(ref: StoredObjectRef): Promise<Blob | undefined> {
      const asset = await db.get("assets", refKey(ref));
      return asset ? new Blob([asset.data], { type: asset.contentType }) : undefined;
    },

    async purgeGroup(groupId: string): Promise<number> {
      const keys = await db.getAllKeysFromIndex("assets", "by-group", groupId);
      for (const key of keys) await db.delete("assets", key);
      if (keys.length > 0) changed();
      return keys.length;
    },

    async clear(): Promise<void> {
      const tx = db.transaction(["masters", "assets"], "readwrite");
      await tx.objectStore("masters").clear();
      await tx.objectStore("assets").clear();
      await tx.done;
      changed();
    },

    async stats(): Promise<MasterCacheStats> {
      const masters = await db.getAll("masters");
      const assets = await db.getAll("assets");
      return {
        collections: masters.map((record) => ({
          collection: record.collection,
          items: record.items.length,
          fetchedAt: record.fetchedAt,
        })),
        assets: {
          count: assets.length,
          bytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
          groups: new Set(assets.map((asset) => asset.groupId)).size,
        },
      };
    },

    async destroy(): Promise<void> {
      if (owned) db.close();
    },
  };
}
