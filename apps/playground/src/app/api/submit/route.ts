import { session, sessionIdOf } from "@/lib/test-server-store";

export const dynamic = "force-dynamic";

/**
 * 点検レコード本体の受け口（playground 版）。
 *
 * ここで確かめたいのは冪等性。弱電界では「サーバには届いたが応答が返らなかった」が
 * 日常的に起きる。端末は当然もう一度送るので、サーバ側が同じ jobId を弾けないと
 * 同じ点検が二重に登録される。
 */
export async function POST(request: Request): Promise<Response> {
  const sessionId = sessionIdOf(request);
  const state = session(sessionId);
  state.submitAttempts++;

  if (state.mode === "submit-redirect") {
    // 認証切れでログイン画面へ飛ばす、いちばん危ない応答。
    // 端末が追いかけて 200 の HTML を受け取ると、成功と誤認してジョブを消しうる
    return new Response(null, { status: 302, headers: { Location: "/login" } });
  }
  if (state.mode === "submit-401") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (state.mode === "submit-503") {
    return Response.json({ error: "unavailable" }, { status: 503 });
  }

  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token || !state.tokens.has(token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const idempotencyKey = request.headers.get("idempotency-key");
  const body = (await request.json()) as { jobId: string; attachments?: unknown[] };
  const key = idempotencyKey ?? body.jobId;

  const existing = state.submitted.get(key);
  if (existing) {
    return Response.json({ id: existing, duplicated: true }, { status: 409 });
  }

  const id = `srv-${state.submitted.size + 1}`;
  state.submitted.set(key, id);
  return Response.json({ id });
}
