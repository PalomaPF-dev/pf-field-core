import Link from "next/link";
import {
  backoffSchedule,
  classifyHttpStatus,
  DEFAULT_BACKOFF,
  DEFAULT_MAX_ATTEMPTS,
  VERSION,
} from "@palomapf-dev/pf-field-core";

/** ms を「2秒」「5分」のような読める形にする */
function humanMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}秒`;
  return `${Math.round(ms / 6_000) / 10}分`;
}

const STATUSES = [200, 400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 503, 507] as const;

export default function Home() {
  const schedule = backoffSchedule();
  const total = schedule.reduce((a, b) => a + b, 0);

  return (
    <main>
      <h1>pf-field-core playground</h1>
      <p className="lead">
        版数 <code>{VERSION}</code> — M0（基盤整備）時点。
      </p>
      <nav>
        <Link href="/diagnostics">実機診断 →</Link>
      </nav>

      <h2>指数バックオフ（既定設定）</h2>
      <p className="lead">
        base {humanMs(DEFAULT_BACKOFF.baseMs)} / factor {DEFAULT_BACKOFF.factor} / 上限{" "}
        {humanMs(DEFAULT_BACKOFF.maxMs)} / {DEFAULT_MAX_ATTEMPTS} 回で打ち切り。
        実際には full jitter で <code>[0, 下記の値]</code> に散らすので、
        端末が一斉に圏内復帰してもサーバへの到着はばらける。
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>失敗回数</th>
              <th className="num">待ち時間の上限</th>
              <th className="num">累積</th>
            </tr>
          </thead>
          <tbody>
            {schedule.map((ms, i) => (
              <tr key={i}>
                <td>{i + 1} 回目</td>
                <td className="num">{humanMs(ms)}</td>
                <td className="num">
                  {humanMs(schedule.slice(0, i + 1).reduce((a, b) => a + b, 0))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="lead">
        合計 {humanMs(total)} ねばってから <code>failed</code>（手動再送で復帰できる状態）に落ちる。
      </p>

      <h2>HTTP ステータスの分類</h2>
      <p className="lead">
        「待てば直る見込みがあるか」だけで決めている。見込みが無いものを再試行に回すと、
        現場では未送信バッジが減らないまま居座ってしまう。
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>ステータス</th>
              <th>種別</th>
              <th>扱い</th>
            </tr>
          </thead>
          <tbody>
            {STATUSES.map((status) => {
              const c = classifyHttpStatus(status);
              return (
                <tr key={status}>
                  <td>
                    <code>{status}</code>
                  </td>
                  <td>{c.kind}</td>
                  <td>
                    {c.retryable ? (
                      <span className="badge ok">自動で再試行</span>
                    ) : (
                      <span className="badge ng">blocked（人手が要る）</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="lead">
        ※ <code>409</code> は「既に受け付け済み」を意味する冪等な成功として送信ランナーが先に処理するので、
        通常この分類には到達しない（M3 で実装）。
      </p>
    </main>
  );
}
