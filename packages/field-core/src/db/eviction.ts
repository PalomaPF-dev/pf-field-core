/**
 * IndexedDB の消失検知。
 *
 * iOS Safari は「7日間サイトを開かないと保存データを消す」。
 * 容量逼迫時にも消える。**利用者は消えたことに気づけない** —
 * 未送信バッジがある日いきなり 0 になるだけで、送ったのか消えたのか区別が付かない。
 *
 * そこで localStorage に「いま未送信が何件あるか」の目印を置き、
 * 起動時に IndexedDB の実際の件数と突き合わせる。
 *
 * **best-effort であることに注意。** iOS の7日ルールは localStorage も含めて
 * まとめて消すため、その場合は目印も消えて検知できない。検知できるのは
 * 「IndexedDB だけが消えた」場合（容量逼迫による部分的な退避など）。
 * それでも、気づける機会があるだけ黙って失うよりましなので入れている。
 */

export interface StorageSentinel {
  /** 目印を書いた時点の未送信件数 */
  unsent: number;
  /** 書いた時刻（epoch ms） */
  at: number;
  dbName: string;
}

export interface EvictionSignal {
  /** 消える前に預かっていた未送信件数 */
  lostJobs: number;
  /** 最後に目印を書いた時刻 */
  lastSeenAt: number;
}

function sentinelKey(appId: string): string {
  return `pf-field-sentinel:${appId}`;
}

function storage(): Storage | null {
  try {
    const value = (globalThis as unknown as { localStorage?: Storage }).localStorage;
    return value ?? null;
  } catch {
    // Safari のプライベートモードなどでアクセス自体が例外になることがある
    return null;
  }
}

export function writeSentinel(appId: string, value: StorageSentinel): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(sentinelKey(appId), JSON.stringify(value));
  } catch {
    // localStorage が満杯・無効。検知できなくなるだけで動作は続く
  }
}

export function readSentinel(appId: string): StorageSentinel | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(sentinelKey(appId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StorageSentinel>;
    if (typeof parsed.unsent !== "number" || typeof parsed.at !== "number") return null;
    return { unsent: parsed.unsent, at: parsed.at, dbName: String(parsed.dbName ?? "") };
  } catch {
    return null;
  }
}

export function clearSentinel(appId: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(sentinelKey(appId));
  } catch {
    /* 消せなくても実害は無い */
  }
}

/**
 * 目印と実際の件数を突き合わせて、消失を判定する。
 *
 * 「預かっていたはずなのに1件も無い」ときだけ消失とみなす。
 * 部分的に減っている場合は、送信できた可能性のほうが高いので鳴らさない
 * （誤検知で「データが消えました」と出すほうが害が大きい）。
 */
export function detectEviction(
  sentinel: StorageSentinel | null,
  actualTotalJobs: number,
): EvictionSignal | null {
  if (!sentinel) return null;
  if (sentinel.unsent <= 0) return null;
  if (actualTotalJobs > 0) return null;
  return { lostJobs: sentinel.unsent, lastSeenAt: sentinel.at };
}

/** 利用者に出す文言。判定と文言を一箇所に置くため。 */
export function describeEviction(signal: EvictionSignal): string {
  return (
    `端末に保存していた未送信データ ${signal.lostJobs} 件が失われました。` +
    `ブラウザが保存領域を解放した可能性があります。お手数ですが入力し直してください。`
  );
}
