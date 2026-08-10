---
"@palomapf-dev/pf-field-core": minor
---

M4: React バインディングと下書きの永続化。

```tsx
// app/providers.tsx
"use client";
import { FieldCoreProvider } from "@palomapf-dev/pf-field-core/react";

export function Providers({ children }) {
  return <FieldCoreProvider config={{ appId: "pf-setsubi", endpoints: { submit: {...} } }}>
    {children}
  </FieldCoreProvider>;
}
```

```tsx
const { counts, jobs, flush, retryAll, isSyncing } = useOfflineQueue();
const { reachable } = useNetworkStatus();

<button onClick={flush} disabled={isSyncing || !reachable}>
  未送信 {counts.unsent} 件を送信
</button>
```

**新しい公開 API**

- `configureFieldCore()` — 設定ひとつから一式（キュー・送信ランナー・URL解決・下書き）を組む
- `FieldCoreProvider` / `useFieldCore` / `useFieldCoreContext`
- `useOfflineQueue()` / `useQueueJob()`
- `useNetworkStatus()` / `useSignedUrl()` / `useSignedUrls()` / `useDraft()`
- `createDraftStore()` / `createFileUrlResolver()`

**下書きの永続化（`useDraft`）**

Zebra 端末は WebView をバックグラウンドで kill する。点検の途中で端末を
胸ポケットに入れた瞬間に入力が消えるなら、「圏外で入力を継続する」は成立しない。
デバウンスして保存し、**画面を離れるときは待たずに書く**
（`visibilitychange` / `pagehide`）。デバウンス待ちの時間がそのまま消えた入力になるため。

**`useNetworkStatus` は `navigator.onLine` を信じない**

`onLine` は「インタフェースが繋がっているか」しか見ておらず、
弱電界・死んだゲートウェイ・認証切れのリダイレクトをすべて `true` と報告する。
`false` は信用してよいが、**真だけが疑わしい**ので実際に叩いて確かめる。

**`useSignedUrl` は往復を減らす**

非公開バケットなので表示のたびに署名の発行が要る。
素朴に書くと一覧に20枚あれば20往復するため、同じティックの要求をまとめ、
期限内は使い回す。期限の30秒手前で捨てるので「表示した瞬間に切れていた」も避ける。

**IndexedDB スキーマ v2**

`drafts` ストアを追加。移行では既存のストアに触らない
（未送信ジョブは端末にしか無いデータのため）。
