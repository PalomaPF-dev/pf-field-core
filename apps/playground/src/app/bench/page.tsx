"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import {
  compressImage,
  DEFAULT_COMPRESS_OPTIONS,
  type CompressedImage,
} from "@palomapf-dev/pf-field-core/image";
import { createStandardSet } from "@/lib/test-image";

/**
 * 実機での圧縮計測。
 *
 * M1 の完了条件は「代表写真20枚で 200〜400KB に収まり、向きが全パターン正しく、
 * 実機で1枚1.5秒以内」。それを判定するための画面。
 *
 * あわせてメインスレッドの詰まり（long task）も測る。
 * Worker へのオフロード（M1b）を入れるかどうかを、憶測ではなく実測で決めるため。
 */

interface Row {
  name: string;
  expectedOrientation: number | null;
  result: CompressedImage;
  previewUrl: string;
}

const TARGET = DEFAULT_COMPRESS_OPTIONS.targetBytes;

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024).toLocaleString()} KB`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2) : (sorted[mid] ?? 0);
}

export default function Bench() {
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [longTasks, setLongTasks] = useState<{ count: number; totalMs: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const run = useCallback(
    async (items: { name: string; blob: Blob; orientation: number | null }[]) => {
      setRunning(true);
      setError(null);
      setRows([]);

      // メインスレッドが何ミリ秒詰まったかを測る
      let taskCount = 0;
      let taskTotal = 0;
      let observer: PerformanceObserver | null = null;
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            taskCount++;
            taskTotal += entry.duration;
          }
        });
        observer.observe({ entryTypes: ["longtask"] });
      } catch {
        observer = null; // longtask 未対応のブラウザ
      }

      try {
        const out: Row[] = [];
        for (const item of items) {
          const result = await compressImage(item.blob);
          out.push({
            name: item.name,
            expectedOrientation: item.orientation,
            result,
            previewUrl: URL.createObjectURL(result.blob),
          });
          setRows([...out]);
        }
        setLongTasks(observer ? { count: taskCount, totalMs: Math.round(taskTotal) } : null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        observer?.disconnect();
        setRunning(false);
      }
    },
    [],
  );

  const runStandard = useCallback(async () => {
    setRunning(true);
    try {
      const photos = await createStandardSet();
      await run(photos.map((p) => ({ name: p.name, blob: p.blob, orientation: p.orientation })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  }, [run]);

  const runFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      await run(
        Array.from(files).map((f) => ({ name: f.name, blob: f, orientation: null })),
      );
    },
    [run],
  );

  const durations = rows.map((r) => r.result.durationMs);
  // 合否は「上限以内か」で判断する。下限未満は失敗ではない
  // （元から小さい写真をわざわざ太らせる理由が無いため）
  const withinCap = rows.filter((r) => r.result.bytes <= TARGET.max).length;
  const overTarget = rows.length - withinCap;
  const underMin = rows.filter((r) => r.result.bytes < TARGET.min).length;
  const orientationOk = rows.filter(
    (r) => r.expectedOrientation === null || r.result.orientation === r.expectedOrientation,
  ).length;

  return (
    <main>
      <h1>圧縮の実機計測</h1>
      <p className="lead">
        目標: 長辺 {DEFAULT_COMPRESS_OPTIONS.maxEdge}px / {kb(TARGET.min)}〜{kb(TARGET.max)} / 1枚 1.5秒以内
      </p>
      <nav>
        <Link href="/">← 戻る</Link>
      </nav>

      <h2>実行</h2>
      <div className="card">
        <p>
          <button onClick={runStandard} disabled={running}>
            {running ? "実行中…" : "テスト画像6枚で計測"}
          </button>{" "}
          <button onClick={() => fileInput.current?.click()} disabled={running}>
            端末の写真を選ぶ
          </button>
        </p>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => void runFiles(e.target.files)}
        />
        <p className="lead">
          実機のカメラで撮った写真を選ぶのが一番確かです。テスト画像は
          4000x3000 を含み、向き 1/3/6/8 を埋め込んであります。
        </p>
      </div>

      {error && (
        <div className="card">
          <strong className="badge ng">エラー</strong> {error}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <h2>集計</h2>
          <div className="scroll">
            <table>
              <tbody>
                <tr>
                  <th>枚数</th>
                  <td className="num">{rows.length}</td>
                </tr>
                <tr>
                  <th>所要時間（中央値 / 最大）</th>
                  <td className="num">
                    {median(durations)} ms / {Math.max(...durations)} ms{" "}
                    {Math.max(...durations) <= 1500 ? (
                      <span className="badge ok">目標内</span>
                    ) : (
                      <span className="badge ng">目標超過</span>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>上限（{kb(TARGET.max)}）以内</th>
                  <td className="num">
                    {withinCap} / {rows.length}{" "}
                    {overTarget === 0 ? (
                      <span className="badge ok">達成</span>
                    ) : (
                      <span className="badge ng">超過 {overTarget} 枚</span>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>下限（{kb(TARGET.min)}）未満</th>
                  <td className="num">
                    {underMin} 枚 <span className="badge warn">参考</span>
                  </td>
                </tr>
                <tr>
                  <th>向きの判定</th>
                  <td className="num">
                    {orientationOk} / {rows.length}{" "}
                    {orientationOk === rows.length ? (
                      <span className="badge ok">一致</span>
                    ) : (
                      <span className="badge ng">不一致あり</span>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>メインスレッドの詰まり</th>
                  <td className="num">
                    {longTasks
                      ? `${longTasks.count} 回 / 合計 ${longTasks.totalMs} ms`
                      : "計測不可（longtask 未対応）"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="lead">
            「メインスレッドの詰まり」が大きいほど、撮影直後に画面が固まります。
            ここが実用に耐えないなら Worker へのオフロード（M1b）を入れます。
          </p>

          <h2>明細</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>ファイル</th>
                  <th>結果</th>
                  <th className="num">元</th>
                  <th className="num">後</th>
                  <th className="num">寸法</th>
                  <th className="num">向き</th>
                  <th className="num">品質</th>
                  <th className="num">回数</th>
                  <th className="num">時間</th>
                  <th>経路</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const r = row.result;
                  const sizeOk = r.bytes <= TARGET.max;
                  const orientationMatch =
                    row.expectedOrientation === null || r.orientation === row.expectedOrientation;
                  return (
                    <tr key={i}>
                      <td>{row.name}</td>
                      <td>
                        {/* next/image は使えない（Blob URL を最適化できないため） */}
                        <img
                          src={row.previewUrl}
                          alt={row.name}
                          width={64}
                          style={{ height: "auto", display: "block" }}
                        />
                      </td>
                      <td className="num">{kb(r.original.bytes)}</td>
                      <td className="num">
                        {kb(r.bytes)}{" "}
                        {sizeOk ? null : <span className="badge ng">超</span>}
                      </td>
                      <td className="num">
                        {r.width}×{r.height}
                      </td>
                      <td className="num">
                        {r.orientation}
                        {orientationMatch ? null : <span className="badge ng">×</span>}
                      </td>
                      <td className="num">{r.quality.toFixed(2)}</td>
                      <td className="num">{r.passes}</td>
                      <td className="num">{r.durationMs} ms</td>
                      <td>{r.renderer}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="lead">
            プレビューの赤い四角が<strong>左上</strong>に見えていれば、向きが正しく焼き込まれています。
            回数 0 は「元のまま送る（再エンコードしない）」と判断したものです。
          </p>
        </>
      )}
    </main>
  );
}
