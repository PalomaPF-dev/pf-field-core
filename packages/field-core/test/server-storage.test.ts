import { describe, expect, it, vi } from "vitest";
import { companyIdOfPath, defaultObjectPath, sanitizeSegment } from "../src/server/path.js";
import { createSupabaseStorageProvider } from "../src/server/supabase.js";
import { createS3StorageProvider } from "../src/server/s3.js";
import { createSignUploadRoute, createSignViewRoute } from "../src/server/routes.js";
import { UnauthorizedError, type AuthContext, type ServerContext } from "../src/server/types.js";
import type { StoredObjectRef } from "../src/storage/types.js";

/**
 * サーバ側の検証。
 *
 * ここで守っているのは**テナント分離**。署名鍵（sb_secret_）は RLS を迂回するので、
 * Supabase 側のポリシーはこの経路の防御にならない。
 * 「誰がどこへ書けるか・何を見られるか」を決めているのは
 * authorize() とサーバ側のパス生成だけで、その2つがここの対象。
 */

const AUTH: AuthContext = { userId: "u-1", companyId: "paloma" };

function ctx(auth: AuthContext = AUTH): ServerContext {
  return { auth, appId: "pf-setsubi", request: new Request("https://app.example.com/api") };
}

const FILES = [
  { attachmentId: "att-1", fileName: "before.jpg", contentType: "image/jpeg", bytes: 300_000 },
];

describe("保存パス", () => {
  it("規約どおりに組み立てる", () => {
    const path = defaultObjectPath({
      appId: "pf-setsubi",
      jobId: "job-1",
      jobType: "setsubi.inspection",
      attachmentId: "att-1",
      fileName: "before.jpg",
      contentType: "image/jpeg",
      auth: AUTH,
      at: new Date("2026-08-10T12:00:00Z"),
    });

    expect(path).toBe("paloma/pf-setsubi/2026/08/job-1/att-1");
  });

  it("★ companyId が無ければ保存先を決めない", () => {
    // 既定値で埋めると全社ぶんが同じプレフィックスに落ち、分離が静かに消える。
    // 落ちて気づくほうがましな種類の失敗
    expect(() =>
      defaultObjectPath({
        appId: "pf-setsubi",
        jobId: "job-1",
        jobType: "t",
        attachmentId: "att-1",
        fileName: "a.jpg",
        contentType: "image/jpeg",
        auth: { userId: "u-1" },
        at: new Date(),
      }),
    ).toThrow(/companyId/);
  });

  it("区切り文字を持ち込ませない", () => {
    expect(sanitizeSegment("../../etc/passwd")).not.toContain("/");
    expect(sanitizeSegment("../../etc")).not.toMatch(/^\./);
  });

  it("パスから会社を取り出せる（閲覧の照合に使う）", () => {
    expect(companyIdOfPath("paloma/pf-setsubi/2026/08/job-1/att-1")).toBe("paloma");
  });
});

describe("Supabase プロバイダ", () => {
  function stubFetch(handler: (url: string, init: RequestInit) => unknown) {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = handler(String(input), init ?? {});
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }) as unknown as typeof fetch;
  }

  it("署名を要求し、端末が使える記述子に組み替える", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const provider = createSupabaseStorageProvider({
      url: "https://proj.supabase.co",
      secretKey: "sb_secret_xxx",
      fetchImpl: stubFetch((url, init) => {
        seen.push({ url, headers: init.headers as Record<string, string> });
        return { url: "/object/upload/sign/field-uploads/paloma/pf-setsubi/2026/08/job-1/att-1?token=jwt" };
      }),
    });

    const targets = await provider.createUploadTargets(
      { jobId: "job-1", jobType: "setsubi.inspection", files: FILES },
      ctx(),
    );

    // 署名要求は Authorization と apikey の両方を載せる
    expect(seen[0]!.url).toContain("/storage/v1/object/upload/sign/field-uploads/");
    expect(seen[0]!.headers.Authorization).toBe("Bearer sb_secret_xxx");
    expect(seen[0]!.headers.apikey).toBe("sb_secret_xxx");

    const target = targets[0]!;
    expect(target.request.method).toBe("PUT");
    expect(target.request.url).toBe(
      "https://proj.supabase.co/storage/v1/object/upload/sign/field-uploads/paloma/pf-setsubi/2026/08/job-1/att-1?token=jwt",
    );
    // 再送で 409 に当たって止まらないよう上書きを許す
    expect(target.request.headers?.["x-upsert"]).toBe("true");
    expect(target.ref).toMatchObject({
      provider: "supabase",
      bucket: "field-uploads",
      path: "paloma/pf-setsubi/2026/08/job-1/att-1",
    });
  });

  it("署名が返らなければ失敗させる（空の記述子を配らない）", async () => {
    const provider = createSupabaseStorageProvider({
      url: "https://proj.supabase.co",
      secretKey: "k",
      fetchImpl: stubFetch(() => ({ error: "Bucket not found" })),
    });

    await expect(
      provider.createUploadTargets({ jobId: "j", jobType: "t", files: FILES }, ctx()),
    ).rejects.toThrow(/署名付きアップロードURL/);
  });

  it("閲覧URLはバッチで発行する", async () => {
    let requestBody: unknown;
    const provider = createSupabaseStorageProvider({
      url: "https://proj.supabase.co",
      secretKey: "k",
      fetchImpl: stubFetch((_url, init) => {
        requestBody = JSON.parse(String(init.body));
        return [
          { path: "paloma/a", signedURL: "/object/sign/field-uploads/paloma/a?token=1" },
          { path: "paloma/b", signedURL: "/object/sign/field-uploads/paloma/b?token=2" },
        ];
      }),
    });

    const refs: StoredObjectRef[] = [
      { provider: "supabase", bucket: "field-uploads", path: "paloma/a" },
      { provider: "supabase", bucket: "field-uploads", path: "paloma/b" },
    ];
    const urls = await provider.createViewUrls!(refs, { ttlSec: 300 }, ctx());

    // 1件ずつ叩くと一覧表示で N 回往復する
    expect(requestBody).toMatchObject({ expiresIn: 300, paths: ["paloma/a", "paloma/b"] });
    expect(urls).toHaveLength(2);
    expect(urls[0]!.url).toBe(
      "https://proj.supabase.co/storage/v1/object/sign/field-uploads/paloma/a?token=1",
    );
  });
});

describe("S3 プロバイダ（差し替えの検証）", () => {
  const provider = createS3StorageProvider({
    bucket: "field-uploads",
    region: "ap-northeast-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    now: () => new Date("2026-08-10T12:00:00Z"),
  });

  it("端末が使う記述子の形は Supabase と同じ", async () => {
    const targets = await provider.createUploadTargets(
      { jobId: "job-1", jobType: "setsubi.inspection", files: FILES },
      ctx(),
    );
    const target = targets[0]!;

    // ★ ここが揃っている限り、端末側のコードは1行も変わらない
    expect(target.request.method).toBe("PUT");
    expect(target.request.bodyMode).toBe("binary");
    expect(target.ref.path).toBe("paloma/pf-setsubi/2026/08/job-1/att-1");
    expect(target.attachmentId).toBe("att-1");
    expect(target.expiresAt).toBeGreaterThan(Date.parse("2026-08-10T12:00:00Z"));
  });

  it("SigV4 のクエリ署名を作る", async () => {
    const targets = await provider.createUploadTargets(
      { jobId: "job-1", jobType: "t", files: FILES },
      ctx(),
    );
    const url = new URL(targets[0]!.request.url);

    expect(url.host).toBe("field-uploads.s3.ap-northeast-1.amazonaws.com");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260810T120000Z");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("20260810/ap-northeast-1/s3/");
    // 署名対象を host だけにしてあるので、端末がヘッダを足しても壊れない
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("★ AWS 公式の例と署名が一致する", async () => {
    /*
     * 自前で SigV4 を書いた以上、「自分の実装どうしで一致する」ことに意味は無い。
     * AWS のドキュメントに載っている presigned URL の計算例と突き合わせて、
     * 外部の正解に一致することを確かめる。
     *
     * 例: examplebucket/test.txt, us-east-1, 2013-05-24T00:00:00Z, 有効期限86400秒
     */
    const aws = createS3StorageProvider({
      bucket: "examplebucket",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      // この例は仮想ホスト形式（リージョンを含まないホスト名）
      endpoint: "https://examplebucket.s3.amazonaws.com",
      forcePathStyle: false,
      now: () => new Date("2013-05-24T00:00:00Z"),
    });

    const [resolved] = await aws.createViewUrls(
      [{ provider: "s3", bucket: "examplebucket", path: "test.txt" }],
      { ttlSec: 86400 },
      ctx(),
    );

    expect(new URL(resolved!.url).searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("同じ入力なら同じ署名（署名が入力に対して決定的）", async () => {
    const a = await provider.createUploadTargets({ jobId: "j", jobType: "t", files: FILES }, ctx());
    const b = await provider.createUploadTargets({ jobId: "j", jobType: "t", files: FILES }, ctx());
    expect(a[0]!.request.url).toBe(b[0]!.request.url);
  });

  it("会社が違えば署名も変わる（パスが違うため）", async () => {
    const a = await provider.createUploadTargets({ jobId: "j", jobType: "t", files: FILES }, ctx());
    const b = await provider.createUploadTargets(
      { jobId: "j", jobType: "t", files: FILES },
      ctx({ userId: "u-2", companyId: "other" }),
    );
    expect(a[0]!.request.url).not.toBe(b[0]!.request.url);
  });
});

describe("Route Handler（認可の実体）", () => {
  const provider = createS3StorageProvider({
    bucket: "field-uploads",
    region: "ap-northeast-1",
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    now: () => new Date("2026-08-10T12:00:00Z"),
  });

  function post(body: unknown): Request {
    return new Request("https://app.example.com/api/uploads/sign", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("未認証は 401", async () => {
    const route = createSignUploadRoute({
      provider,
      appId: "pf-setsubi",
      authorize: async () => undefined,
    });
    const response = await route(post({ jobId: "j", jobType: "t", files: FILES }));
    expect(response.status).toBe(401);
  });

  it("UnauthorizedError も 401 に変換する", async () => {
    const route = createSignUploadRoute({
      provider,
      appId: "pf-setsubi",
      authorize: async () => {
        throw new UnauthorizedError();
      },
    });
    expect((await route(post({ jobId: "j", jobType: "t", files: FILES }))).status).toBe(401);
  });

  it("許可していない MIME は 415（端末は再試行しない）", async () => {
    const route = createSignUploadRoute({
      provider,
      appId: "pf-setsubi",
      authorize: async () => AUTH,
    });
    const response = await route(
      post({
        jobId: "j",
        jobType: "t",
        files: [{ attachmentId: "a", fileName: "x.exe", contentType: "application/x-msdownload", bytes: 10 }],
      }),
    );
    expect(response.status).toBe(415);
  });

  it("大きすぎる添付は 413", async () => {
    const route = createSignUploadRoute({
      provider,
      appId: "pf-setsubi",
      authorize: async () => AUTH,
      maxBytes: 1000,
    });
    const response = await route(
      post({
        jobId: "j",
        jobType: "t",
        files: [{ attachmentId: "a", fileName: "x.jpg", contentType: "image/jpeg", bytes: 5000 }],
      }),
    );
    expect(response.status).toBe(413);
  });

  it("★ クライアントが指定したファイル名は保存パスに使わない", async () => {
    const route = createSignUploadRoute({
      provider,
      appId: "pf-setsubi",
      authorize: async () => AUTH,
    });
    const response = await route(
      post({
        jobId: "job-1",
        jobType: "t",
        files: [
          {
            attachmentId: "att-1",
            fileName: "../../other-company/secret.jpg",
            contentType: "image/jpeg",
            bytes: 100,
          },
        ],
      }),
    );

    const body = (await response.json()) as { targets: { ref: StoredObjectRef }[] };
    expect(body.targets[0]!.ref.path).toBe("paloma/pf-setsubi/2026/08/job-1/att-1");
  });

  it("★ 他社のファイルの閲覧URLは発行しない", async () => {
    const route = createSignViewRoute({
      provider,
      appId: "pf-setsubi",
      authorize: async () => AUTH,
    });

    const response = await route(
      new Request("https://app.example.com/api/files/sign-view", {
        method: "POST",
        body: JSON.stringify({
          refs: [
            { provider: "s3", bucket: "field-uploads", path: "other-company/pf-setsubi/2026/08/j/a" },
          ],
        }),
      }),
    );

    // 署名鍵は RLS を迂回するので、ここで止めないと他社の写真が見える
    expect(response.status).toBe(403);
  });

  it("自社のファイルなら発行する", async () => {
    const route = createSignViewRoute({
      provider,
      appId: "pf-setsubi",
      authorize: async () => AUTH,
    });

    const response = await route(
      new Request("https://app.example.com/api/files/sign-view", {
        method: "POST",
        body: JSON.stringify({
          refs: [{ provider: "s3", bucket: "field-uploads", path: "paloma/pf-setsubi/2026/08/j/a" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { urls: { url: string }[] };
    expect(body.urls).toHaveLength(1);
  });

  it("署名付きURLの応答は経路上に残さない", async () => {
    const route = createSignUploadRoute({
      provider,
      appId: "pf-setsubi",
      authorize: async () => AUTH,
    });
    const response = await route(post({ jobId: "j", jobType: "t", files: FILES }));
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
