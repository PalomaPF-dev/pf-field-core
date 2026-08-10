import { session, sessionIdOf } from "@/lib/test-server-store";

export const dynamic = "force-dynamic";

/**
 * ジョブ単位の送信トークンの発行（playground 版）。
 *
 * 本番でもここが要点: **認証が生きているうち（＝ジョブ投入時）に発行する。**
 * Cookie ではないので、無操作ログアウト（共用端末15分）やセッション期限（12時間）で
 * 認証が切れても、預かった写真は送れる。
 */
export async function POST(request: Request): Promise<Response> {
  const state = session(sessionIdOf(request));
  const { jobId } = (await request.json()) as { jobId: string };

  const token = `jt_${jobId}`;
  state.tokens.add(token);

  return Response.json({
    token,
    // 26時間。next-auth のセッション（12時間）より長く、
    // 「夕方に撮って翌朝に圏内へ戻る」までを1本で賄う
    expiresAt: Date.now() + 26 * 60 * 60 * 1000,
  });
}
