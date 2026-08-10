import { session, sessionIdOf } from "@/lib/test-server-store";
import type { StoredObjectRef } from "@palomapf-dev/pf-field-core";

export const dynamic = "force-dynamic";

/**
 * 閲覧用の署名付きURL（playground 版）。
 *
 * 本番は Supabase の createSignedUrl() を呼ぶが、
 * 端末から見た契約（{ urls: [{ ref, url, expiresAt }] }）は同じ。
 */
export async function POST(request: Request): Promise<Response> {
  const sessionId = sessionIdOf(request);
  const state = session(sessionId);
  const { refs, ttlSec } = (await request.json()) as { refs: StoredObjectRef[]; ttlSec?: number };

  const ttl = (ttlSec ?? 300) * 1000;
  const urls = refs
    .filter((ref) => state.objects.has(ref.path))
    .map((ref) => ({
      ref,
      url: `/api/uploads/get/${encodeURI(ref.path)}?session=${encodeURIComponent(sessionId)}`,
      expiresAt: Date.now() + ttl,
    }));

  return Response.json({ urls }, { headers: { "Cache-Control": "private, no-store" } });
}
