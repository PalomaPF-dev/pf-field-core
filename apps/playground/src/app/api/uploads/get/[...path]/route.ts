import { session } from "@/lib/test-server-store";

export const dynamic = "force-dynamic";

/** アップロード済みの中身を返す（playground 版）。本番は署名付きURLで直接配信される */
export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  const url = new URL(_request.url);
  const state = session(url.searchParams.get("session") ?? "default");

  const bytes = state.objects.get(path.join("/"));
  if (bytes === undefined) return new Response("not found", { status: 404 });

  const body = state.bodies.get(path.join("/")) ?? new Uint8Array(bytes);
  return new Response(body as unknown as ArrayBufferView<ArrayBuffer>, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" },
  });
}
