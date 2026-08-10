import { session, sessionIdOf, type FailureMode } from "@/lib/test-server-store";

export const dynamic = "force-dynamic";

/** E2E がサーバ側の失敗を切り替えるための口。playground 専用 */
export async function POST(request: Request): Promise<Response> {
  const state = session(sessionIdOf(request));
  const { mode } = (await request.json()) as { mode: FailureMode };
  state.mode = mode;
  return Response.json({ mode });
}
