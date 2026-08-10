"use client";

import Link from "next/link";
import { useImageCapabilities } from "@palomapf-dev/pf-field-core/react";
import { VERSION } from "@palomapf-dev/pf-field-core";

/**
 * 実機（Zebra ハンディ）で開いて、画像処理まわりの対応状況を採取するための画面。
 *
 * WebView のバージョンが未確定のまま設計を進めているので、
 * ここで採れた結果をもって M1 のフォールバック経路の優先度を決める。
 */

function Mark({ value }: { value: boolean }) {
  return value ? <span className="badge ok">対応</span> : <span className="badge ng">非対応</span>;
}

const ROWS: { key: string; label: string; note: string }[] = [
  {
    key: "createImageBitmap",
    label: "createImageBitmap",
    note: "無ければ <img> + createObjectURL に落ちる",
  },
  {
    key: "imageOrientationFromImage",
    label: "imageOrientation: 'from-image'",
    note: "Chrome 79+。無ければ EXIF を自前で読んで canvas で補正する",
  },
  {
    key: "offscreenCanvas",
    label: "OffscreenCanvas",
    note: "無ければ HTMLCanvasElement.toBlob に落ちる",
  },
  {
    key: "convertToBlob",
    label: "OffscreenCanvas.convertToBlob",
    note: "OffscreenCanvas 経路を使う条件",
  },
  { key: "htmlCanvas", label: "HTMLCanvasElement", note: "最終フォールバック" },
  { key: "worker", label: "Worker", note: "無ければメインスレッドで圧縮する（UI が固まりやすい）" },
  { key: "webp", label: "WebP エンコード", note: "既定は JPEG。実機の互換確認後に検討する" },
];

export default function Diagnostics() {
  const { capabilities, probing } = useImageCapabilities();

  return (
    <main>
      <h1>実機診断</h1>
      <p className="lead">
        版数 <code>{VERSION}</code>
      </p>
      <nav>
        <Link href="/">← 戻る</Link>
      </nav>

      <h2>画像処理の対応状況</h2>

      {probing && <p className="lead">検出中…</p>}

      {!probing && !capabilities && (
        <div className="card">
          <p>検出に失敗しました。ブラウザのコンソールを確認してください。</p>
        </div>
      )}

      {capabilities && (
        <>
          <div className="card">
            採用されるレンダラ: <code>{capabilities.renderer}</code>
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
                {ROWS.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <code>{row.label}</code>
                    </td>
                    <td>
                      <Mark value={Boolean((capabilities as unknown as Record<string, boolean>)[row.key])} />
                    </td>
                    <td>{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>採取用（コピーして共有）</h2>
          <div className="scroll">
            <pre className="card">
              <code>{JSON.stringify({ version: VERSION, ...capabilities }, null, 2)}</code>
            </pre>
          </div>
        </>
      )}

      <h2>この画面の使い方</h2>
      <div className="card">
        <p>
          Zebra 端末の実機でこの URL を開き、上の JSON をそのまま共有してください。
          <code>imageOrientation: &apos;from-image&apos;</code> が非対応だった場合は、
          M1 で EXIF を自前で読んで補正する経路を主経路に切り替えます
          （どちらでも動きますが、自前補正のほうが遅く、対応漏れのリスクがあります）。
        </p>
      </div>
    </main>
  );
}
