import { session, sessionIdOf } from "@/lib/test-server-store";

export const dynamic = "force-dynamic";

/**
 * サーバ側に何が残ったかを E2E から見るための口。playground 専用。
 *
 * 画面の表示だけを見て「送れた」と判断すると、
 * 端末が成功と思い込んでいるだけの状態を見逃す。実際にサーバへ着いたものを数える。
 */
export async function GET(request: Request): Promise<Response> {
  const state = session(sessionIdOf(request));
  return Response.json({
    mode: state.mode,
    objects: [...state.objects.keys()],
    uploadCounts: Object.fromEntries(state.uploadCounts),
    submitted: [...state.submitted.keys()],
    submitAttempts: state.submitAttempts,
  });
}
