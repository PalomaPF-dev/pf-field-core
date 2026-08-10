import { buildTargets, session, sessionIdOf } from "@/lib/test-server-store";

export const dynamic = "force-dynamic";

/**
 * 署名付きアップロードURLの発行（playground 版）。
 *
 * 本番では Supabase の createSignedUploadUrl() を呼ぶが、
 * 端末側から見た契約（UploadTarget を返す）は同じ。
 * だからこのエンドポイントを差し替えても、キューもランナーも変わらない。
 */
export async function POST(request: Request): Promise<Response> {
  const sessionId = sessionIdOf(request);
  const state = session(sessionId);

  // 送信トークンは投入時に発行済みのはず。無ければ 401
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token || !state.tokens.has(token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as Parameters<typeof buildTargets>[1];

  return Response.json({ targets: buildTargets(sessionId, body) });
}
