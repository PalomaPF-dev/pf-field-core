import { session } from "@/lib/test-server-store";

export const dynamic = "force-dynamic";

/**
 * アップロードの受け口（playground 版）。
 * 本番では Supabase の署名付きURLへ端末から直接送るので、この経路は存在しない。
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session") ?? "default";
  const attachmentId = url.searchParams.get("att") ?? "";
  const state = session(sessionId);

  const seen = (state.uploadCounts.get(attachmentId) ?? 0) + 1;
  state.uploadCounts.set(attachmentId, seen);

  if (state.mode === "upload-network") {
    // 圏外相当。待てば直る側に分類されてほしい
    return new Response("upstream unavailable", { status: 503 });
  }
  // 2枚目以降だけ落として「途中で切れた」を作る。1枚目は保存済みになる
  if (state.mode === "upload-partial" && !attachmentId.endsWith("-1")) {
    return new Response("connection reset", { status: 503 });
  }

  const key = path.join("/");
  const body = await request.arrayBuffer();

  // 既に在る = 前回の再試行が実は成功していた。冪等な成功として 409 を返す
  if (state.objects.has(key)) {
    return new Response(null, { status: 409 });
  }

  state.objects.set(key, body.byteLength);
  state.bodies.set(key, new Uint8Array(body));
  return new Response(null, { status: 200 });
}
