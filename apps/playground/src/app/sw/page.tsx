"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  registerFieldServiceWorker,
  requestQueueSync,
  type SyncRequestResult,
} from "@palomapf-dev/pf-field-core/sw";
import { useCapabilities } from "@palomapf-dev/pf-field-core/react";

/**
 * Service Worker と Background Sync の実機確認。
 *
 * ここで見たいのは**エンジンによる差**そのもの:
 *   Android Chrome → Background Sync に登録できる（アプリを閉じても送られる）
 *   iOS Safari     → 登録できない。開いている間のトリガに頼る
 *
 * どちらも「動いている」状態であり、iOS が壊れているわけではない。
 * UI がその差を正しく出し分けられることが要件（capabilities.backgroundSync）。
 *
 * なお「API がある」ことと「登録できる」ことは別。
 * ヘッドレスの Chromium は API を持ちながら register を拒否する。
 * 実機でも登録上限や設定で拒否されうるので、理由も画面に出しておく。
 */
export default function SwPage() {
  const { capabilities } = useCapabilities();
  const [state, setState] = useState<string>("未登録");
  const [sync, setSync] = useState<SyncRequestResult | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const result = await registerFieldServiceWorker({ url: "/sw.js" });
      if (!alive) return;

      if (!result.registration) {
        setState(`登録できません（${result.reason}）`);
        return;
      }
      // 有効になるまで待つ
      await navigator.serviceWorker.ready;
      if (!alive) return;
      setState("有効");

      setSync(await requestQueueSync("pf-field-queue", result.registration));
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main>
      <h1>Service Worker</h1>
      <nav>
        <Link href="/">← 戻る</Link>
      </nav>

      <div className="card">
        状態: <strong data-testid="sw-state">{state}</strong>
      </div>

      <div className="card">
        Background Sync:{" "}
        <span data-testid="bgsync">{capabilities.backgroundSync ? "対応" : "非対応"}</span>
        {sync && (
          <>
            {" / 登録: "}
            <span data-testid="sync-registered">{sync.registered ? "した" : "しない"}</span>
            {" / 前面が要る: "}
            <span data-testid="requires-foreground">
              {sync.requiresForeground ? "はい" : "いいえ"}
            </span>
            {sync.reason && (
              <>
                {" / 理由: "}
                <span data-testid="sync-reason">{sync.reason}</span>
              </>
            )}
          </>
        )}
      </div>

      {sync?.requiresForeground && (
        <div className="card" data-testid="foreground-notice">
          <span className="badge warn">注意</span> 送信完了までアプリを開いたままにしてください
        </div>
      )}
    </main>
  );
}
