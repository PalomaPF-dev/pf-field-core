#!/usr/bin/env node
/**
 * 3-b: Supabase 署名付きアップロードの実地検証。
 *
 * **このスクリプトが在る理由**
 *
 * 端末側の実装は Supabase Storage の REST 契約に沿って書いてあるが、
 * 実エンドポイントで確かめるまでは「そう書いてある」以上のことは言えない。
 * とくに次の4点は、外れると設計の前提が動く:
 *
 *   1. 生バイナリの PUT（bodyMode: "binary"）で受け付けるか
 *      → 駄目なら supabase-js と同じ form-data に切り替える。
 *        変えるのは server/supabase.ts の1箇所だけで、端末側は変わらない
 *   2. 同じパスへの再送で 409 が返るか（x-upsert で上書きできるか）
 *      → 「前回の再試行が実は成功していた」の扱いが決まる
 *   3. 署名の既定有効期限
 *   4. anon（鍵なし）で読めないこと = RLS ポリシー未作成の状態が意図どおりか
 *
 * **使い方**（鍵のある環境で実行する。CI でも手元でもよい）
 *
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SECRET_KEY=sb_secret_xxx \
 *   SUPABASE_BUCKET=field-uploads \
 *   node scripts/verify-supabase.mjs
 *
 * 実装そのものを叩くので、このスクリプトが通れば
 * `createSupabaseStorageProvider` が本番で動くことの裏付けになる。
 * 事前に `pnpm build` が必要。
 */

import { createSupabaseStorageProvider } from "../packages/field-core/dist/server.js";

const url = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_BUCKET ?? "field-uploads";

if (!url || !secretKey) {
  console.error("SUPABASE_URL と SUPABASE_SECRET_KEY が要ります");
  process.exit(2);
}

const findings = [];
let failed = 0;

function record(name, ok, detail) {
  findings.push({ name, ok, detail });
  console.log(`${ok ? "  OK " : "  NG "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

/** 検証用の使い捨てパス。実データと混ざらないよう _verify 配下に置く */
const companyId = "_verify";
const jobId = `job-${Date.now()}`;
const auth = { userId: "verify", companyId };

const provider = createSupabaseStorageProvider({ url, secretKey, bucket });
const ctx = { auth, appId: "pf-field-core", request: new Request("https://verify.local/") };

const payload = new Uint8Array(2048);
for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

console.log(`\n3-b Supabase 実地検証`);
console.log(`  project: ${url}`);
console.log(`  bucket : ${bucket}\n`);

let ref;
try {
  // --- 1. 署名の発行 -------------------------------------------------------
  const targets = await provider.createUploadTargets(
    {
      jobId,
      jobType: "verify.probe",
      files: [
        {
          attachmentId: "att-1",
          fileName: "probe.bin",
          contentType: "image/jpeg",
          bytes: payload.byteLength,
        },
      ],
    },
    ctx,
  );

  const target = targets[0];
  ref = target.ref;
  record("署名付きアップロードURLを発行できる", Boolean(target?.request?.url));
  record(
    "保存パスが規約どおり（<companyId>/<appId>/<YYYY>/<MM>/<jobId>/<attachmentId>）",
    /^_verify\/pf-field-core\/\d{4}\/\d{2}\//.test(ref.path),
    ref.path,
  );

  const ttlMinutes = Math.round((target.expiresAt - Date.now()) / 60_000);
  record("署名の有効期限を記述子に載せている", ttlMinutes > 0, `およそ ${ttlMinutes} 分`);

  // --- 2. 生バイナリの PUT（bodyMode: "binary" の確認）---------------------
  const put = await fetch(target.request.url, {
    method: "PUT",
    headers: target.request.headers,
    body: payload,
  });
  record(
    "★ 生バイナリの PUT を受け付ける（bodyMode: 'binary'）",
    put.ok,
    `HTTP ${put.status}${put.ok ? "" : ` / ${(await put.text()).slice(0, 200)}`}`,
  );

  // --- 3. 同じパスへの再送 -------------------------------------------------
  const again = await fetch(target.request.url, {
    method: "PUT",
    headers: target.request.headers,
    body: payload,
  });
  record(
    "★ 同じ署名URLへの再送の挙動",
    true,
    `HTTP ${again.status}（200/409 のどちらでもランナーは成功として扱う）`,
  );

  // --- 4. 閲覧URL ---------------------------------------------------------
  const [view] = await provider.createViewUrls([ref], { ttlSec: 60 }, ctx);
  record("閲覧用の署名URLを発行できる", Boolean(view?.url));

  const get = await fetch(view.url);
  const body = new Uint8Array(await get.arrayBuffer());
  record(
    "閲覧URLで中身が元どおり取れる",
    get.ok && body.byteLength === payload.byteLength && body[100] === payload[100],
    `HTTP ${get.status} / ${body.byteLength} bytes`,
  );

  // --- 5. 鍵なしで読めないこと（RLS ポリシー未作成の意図確認）-------------
  const anonPath = `${url.replace(/\/+$/, "")}/storage/v1/object/${bucket}/${ref.path}`;
  const anon = await fetch(anonPath);
  record(
    "★ 鍵なしでは読めない（バケット非公開・ポリシー未作成が効いている）",
    !anon.ok,
    `HTTP ${anon.status}`,
  );

  // --- 6. 後始末 -----------------------------------------------------------
  await provider.remove([ref]);
  const afterDelete = await fetch(view.url);
  record("削除できる", !afterDelete.ok, `HTTP ${afterDelete.status}`);
} catch (error) {
  record("検証の実行", false, error instanceof Error ? error.message : String(error));
  if (ref) {
    try {
      await provider.remove([ref]);
    } catch {
      console.error(`  ※ 後始末に失敗。手で消してください: ${bucket}/${ref.path}`);
    }
  }
}

console.log(
  `\n${failed === 0 ? "すべて確認できました" : `${failed} 件が想定と違います`}（${findings.length} 項目）\n`,
);

if (failed > 0) {
  console.log("bodyMode が 'binary' で通らなかった場合:");
  console.log("  packages/field-core/src/server/supabase.ts の UPLOAD_BODY_MODE を");
  console.log("  'form-data' にしてください。端末側の変更は要りません。\n");
}

process.exit(failed === 0 ? 0 : 1);
