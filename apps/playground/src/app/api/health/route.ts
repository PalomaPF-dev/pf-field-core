export const dynamic = "force-dynamic";

/** 到達性プローブ。navigator.onLine が当てにならないので実際に叩く先 */
export async function GET(): Promise<Response> {
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
