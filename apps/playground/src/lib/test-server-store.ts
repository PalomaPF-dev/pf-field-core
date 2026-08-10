import type { StoredObjectRef, UploadTarget } from "@palomapf-dev/pf-field-core";

/**
 * playground のサーバ側の受け皿。プロセス内のメモリだけで完結する。
 *
 * ここが在る理由は、送信ランナー（M3）を**実 HTTP・実ブラウザ**で確かめるため。
 * 単体テストは memory アダプタで済むが、
 * 「圏外から戻ったら自動で送られる」「切れたら残りだけ送る」「二重に登録されない」は
 * 実際の fetch・XHR・IndexedDB を通さないと確かめたことにならない。
 *
 * **セッションごとに状態を分けている。** E2E は複数ワーカーで並列に走り、
 * サーバは1本しか立たない。分けておかないとテスト同士が互いの状態を壊す。
 */

export type FailureMode =
  | "ok"
  /** 署名は通るがアップロードが落ちる（圏外相当） */
  | "upload-network"
  /** 2枚目以降のアップロードだけ落とす（途中切断の再現） */
  | "upload-partial"
  /** 本体送信が 401（認証切れ） */
  | "submit-401"
  /** 本体送信がログイン画面へリダイレクト */
  | "submit-redirect"
  /** 本体送信が 503（待てば直る） */
  | "submit-503";

export interface SessionState {
  mode: FailureMode;
  /** バケット内パス → バイト数 */
  objects: Map<string, number>;
  /** 中身そのもの。閲覧URLで返して画像表示まで通すために持つ */
  bodies: Map<string, Uint8Array>;
  /** アップロードを受けた回数（attachmentId ごと）。二重送信の検査に使う */
  uploadCounts: Map<string, number>;
  /** 冪等キー（jobId）→ 採番した ID。重複は 409 で返す */
  submitted: Map<string, string>;
  /** 本体送信を受けた回数（重複排除が効いているかの検査用） */
  submitAttempts: number;
  tokens: Set<string>;
}

const sessions = new Map<string, SessionState>();

export function session(id: string): SessionState {
  let state = sessions.get(id);
  if (!state) {
    state = {
      mode: "ok",
      objects: new Map(),
      bodies: new Map(),
      uploadCounts: new Map(),
      submitted: new Map(),
      submitAttempts: 0,
      tokens: new Set(),
    };
    sessions.set(id, state);
  }
  return state;
}

export function sessionIdOf(request: Request): string {
  return request.headers.get("x-test-session") ?? "default";
}

export function buildTargets(
  sessionId: string,
  body: { jobId: string; jobType: string; files: { attachmentId: string; fileName: string; contentType: string; bytes: number }[] },
): UploadTarget[] {
  const at = Date.now();
  return body.files.map((file) => {
    // ★ パスはサーバが組み立てる。クライアントの指定は使わない
    const path = `pf-playground/${body.jobType}/${body.jobId}/${file.attachmentId}.bin`;
    const ref: StoredObjectRef = {
      provider: "playground",
      bucket: "field-uploads",
      path,
      contentType: file.contentType,
      bytes: file.bytes,
    };
    return {
      attachmentId: file.attachmentId,
      ref,
      request: {
        // 相対 URL にしてある。絶対 URL だと、サーバが見ているホスト名
        // （localhost）と画面のホスト名（127.0.0.1）がずれたときに
        // 別オリジン扱いになり、XHR が CORS で落ちる
        url: `/api/uploads/put/${encodeURI(path)}?session=${encodeURIComponent(sessionId)}&att=${encodeURIComponent(file.attachmentId)}`,
        method: "PUT",
        bodyMode: "binary",
      },
      expiresAt: at + 2 * 60 * 60 * 1000,
    };
  });
}
