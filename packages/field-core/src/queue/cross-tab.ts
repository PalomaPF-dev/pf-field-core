/**
 * タブ間の変更通知。
 *
 * 排他（lock.ts）は「二重に送らない」ためのもので、
 * **送った結果を他のタブへ伝える役目は持っていない**。
 * 排他だけだと、送信した側のタブは 0 件になり、
 * もう一方のタブは未送信バッジを抱えたまま残る。
 * 現場では「片方の画面だけ古い」＝「送れていない」に見える。
 *
 * Service Worker から送った場合も同じで、
 * SW 側のキューがこのチャンネルへ流せば開いている画面が追従する。
 *
 * BroadcastChannel が無い環境では黙って何もしない。
 * 単一タブでの動作には影響しないので、そこで落とす理由が無い。
 */

import { now } from "../shared/clock.js";

export interface CrossTabChannel {
  /** 自分の変更を他タブへ知らせる */
  post(): void;
  close(): void;
  readonly available: boolean;
}

export interface CrossTabOptions {
  /** DB ごとに分ける。別アプリ・別セッションのキューと混ざらないように */
  name: string;
  /** 自分が出したメッセージを自分で受け取らないための識別子 */
  selfId: string;
  onRemoteChange: () => void;
  /**
   * 受信をまとめる間隔。送信中は変更が連続するので、
   * 1件ごとに受信側で件数を数え直すと無駄が多い
   */
  coalesceMs?: number;
}

interface Message {
  from: string;
  at: number;
}

export const DEFAULT_COALESCE_MS = 150;

function channelCtor(): typeof BroadcastChannel | undefined {
  return typeof BroadcastChannel === "function" ? BroadcastChannel : undefined;
}

export function crossTabAvailable(): boolean {
  return channelCtor() !== undefined;
}

export function createCrossTabChannel(options: CrossTabOptions): CrossTabChannel {
  const Ctor = channelCtor();
  if (!Ctor) {
    return { post: () => {}, close: () => {}, available: false };
  }

  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  let channel: BroadcastChannel | null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    channel = new Ctor(options.name);
    // Node の BroadcastChannel は参照を持ったままだとプロセスが終了しない。
    // SSR や CLI から core を触ったときにプロセスが終わらなくなるのを避ける
    (channel as { unref?: () => void }).unref?.();
  } catch {
    // 生成に失敗する環境（一部の埋め込み WebView）でも動作は続ける
    return { post: () => {}, close: () => {}, available: false };
  }

  channel.onmessage = (event: MessageEvent) => {
    const message = event.data as Message | undefined;
    // 自分が出したものは無視する。無視しないと post → 受信 → 通知 で回り続ける
    if (!message || message.from === options.selfId) return;

    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      options.onRemoteChange();
    }, coalesceMs);
  };

  return {
    available: true,
    post: () => {
      try {
        channel?.postMessage({ from: options.selfId, at: now() } satisfies Message);
      } catch {
        // 閉じた後の post など。通知が届かないだけで送信には影響しない
      }
    },
    close: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        channel?.close();
      } catch {
        // 二重 close は無視
      }
      channel = null;
    },
  };
}
