"use client";

import Link from "next/link";
import { useCapabilities, useImageCapabilities } from "@palomapf-dev/pf-field-core/react";
import { VERSION } from "@palomapf-dev/pf-field-core";

/**
 * 実機で開いて対応状況を採取するための画面。
 *
 * Android（Zebra）と iPhone の両方で開き、下の JSON を共有してもらう。
 * 「送信が終わるまで開いたままにしてください」を出すかどうかの判断は
 * `requiresForegroundToSend` を見る — その出し分けの実例もここに置いてある。
 */

function Mark({ value }: { value: boolean }) {
  return value ? <span className="badge ok">対応</span> : <span className="badge ng">非対応</span>;
}

const IMAGE_ROWS: { key: string; label: string; note: string }[] = [
  {
    key: "createImageBitmap",
    label: "createImageBitmap",
    note: "無ければ <img> + createObjectURL に落ちる",
  },
  {
    key: "imageOrientationFromImage",
    label: "imageOrientation: 'from-image'",
    note: "無ければ EXIF を自前で読んで canvas で補正する",
  },
  {
    key: "offscreenCanvas",
    label: "OffscreenCanvas",
    note: "無ければ HTMLCanvasElement.toBlob に落ちる",
  },
  { key: "convertToBlob", label: "OffscreenCanvas.convertToBlob", note: "OffscreenCanvas 経路の条件" },
  { key: "htmlCanvas", label: "HTMLCanvasElement", note: "最終フォールバック" },
  { key: "worker", label: "Worker", note: "オフロードは M1b。現状は未使用" },
  { key: "webp", label: "WebP エンコード", note: "既定は JPEG" },
];

export default function Diagnostics() {
  const { capabilities, probed, probing, syncDescription } = useCapabilities();
  const { capabilities: image } = useImageCapabilities();

  return (
    <main>
      <h1>実機診断</h1>
      <p className="lead">
        版数 <code>{VERSION}</code> / 端末 <code>{capabilities.platform}</code>
      </p>
      <nav>
        <Link href="/">← 戻る</Link>
      </nav>

      <h2>送信の振る舞い</h2>
      <div className="card">
        <p style={{ margin: 0 }}>{syncDescription}</p>
      </div>

      {/* ★ 他アプリがそのまま真似できる出し分けの実例 */}
      {capabilities.requiresForegroundToSend && (
        <div className="card">
          <span className="badge warn">注意</span> 送信完了までアプリを開いたままにしてください
        </div>
      )}

      <div className="scroll">
        <table>
          <tbody>
            <tr>
              <th>Service Worker</th>
              <td className="num">
                <Mark value={capabilities.serviceWorker} />
              </td>
            </tr>
            <tr>
              <th>Background Sync</th>
              <td className="num">
                <Mark value={capabilities.backgroundSync} />
              </td>
            </tr>
            <tr>
              <th>Periodic Background Sync</th>
              <td className="num">
                <Mark value={capabilities.periodicBackgroundSync} />
              </td>
            </tr>
            <tr>
              <th>送信のきっかけ</th>
              <td className="num">{capabilities.syncTriggers.join(" / ")}</td>
            </tr>
            <tr>
              <th>ハードウェアスキャナ</th>
              <td className="num">
                <Mark value={capabilities.hardwareScanner} />
                {!capabilities.hardwareScanner && (
                  <>
                    {" "}
                    <span className="lead">（手入力にフォールバック）</span>
                  </>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>ストレージ</h2>
      <div className="scroll">
        <table>
          <tbody>
            <tr>
              <th>IndexedDB</th>
              <td className="num">
                <Mark value={capabilities.indexedDB} />
              </td>
            </tr>
            <tr>
              <th>storage.estimate()</th>
              <td className="num">
                <Mark value={capabilities.storageEstimate} />
              </td>
            </tr>
            <tr>
              <th>storage.persist()</th>
              <td className="num">
                <Mark value={capabilities.storagePersistence} />
              </td>
            </tr>
            <tr>
              <th>永続化の許可</th>
              <td className="num">
                {probing ? (
                  "確認中…"
                ) : probed?.storagePersisted ? (
                  <span className="badge ok">許可</span>
                ) : (
                  <span className="badge warn">未許可</span>
                )}
              </td>
            </tr>
            <tr>
              <th>Web Locks</th>
              <td className="num">
                <Mark value={capabilities.webLocks} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {!probing && !probed?.storagePersisted && capabilities.storagePersistence && (
        <div className="card">
          <span className="badge warn">注意</span>{" "}
          保存が保証されていません。しばらく使わないと、未送信データがブラウザに消される場合があります。
        </div>
      )}

      <h2>画像処理</h2>
      {image ? (
        <>
          <div className="card">
            採用されるレンダラ: <code>{image.renderer}</code>
          </div>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>機能</th>
                  <th>結果</th>
                  <th>無いときの代替</th>
                </tr>
              </thead>
              <tbody>
                {IMAGE_ROWS.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <code>{row.label}</code>
                    </td>
                    <td>
                      <Mark
                        value={Boolean((image as unknown as Record<string, boolean>)[row.key])}
                      />
                    </td>
                    <td>{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="lead">検出中…</p>
      )}

      <h2>採取用（コピーして共有）</h2>
      <div className="scroll">
        <pre className="card">
          <code>
            {JSON.stringify(
              { version: VERSION, ...capabilities, ...(probed ?? {}), ...(image ?? {}) },
              null,
              2,
            )}
          </code>
        </pre>
      </div>

      <h2>この画面の使い方</h2>
      <div className="card">
        <p>
          Android（Zebra）と iPhone の両方でこの URL を開き、上の JSON をそのまま共有してください。
          とくに <code>backgroundSync</code> と <code>永続化の許可</code> は、
          端末ごとに UI の出し分けが要るかどうかを決める値です。
        </p>
      </div>
    </main>
  );
}
