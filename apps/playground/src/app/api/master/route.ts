export const dynamic = "force-dynamic";

/** マスタの取得（playground 版）。会社・工場で絞った結果だけを返す想定 */
export async function GET(): Promise<Response> {
  return Response.json([
    {
      collection: "equipment",
      version: "v1",
      items: [
        { id: "EQ-1", name: "ボイラー1号", workplace: "第1工場" },
        { id: "EQ-2", name: "ボイラー2号", workplace: "第1工場" },
        { id: "EQ-3", name: "コンプレッサー", workplace: "第2工場" },
      ],
    },
    { collection: "workplaces", version: "v1", items: [{ id: "W1" }, { id: "W2" }] },
  ]);
}
