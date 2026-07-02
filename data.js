// /api/data — THL時間割ツールの共有データAPI（Vercel Serverless Function）
// GET  : 誰でも可。保存されている時間割データ一式を返す
// PUT  : 編集パスワード（環境変数 EDIT_TOKEN）が必要。データ一式を保存する
//        baseUpdatedAt が最新と一致しない場合は 409（他の人が先に更新）を返す
// データ保存先: Upstash Redis（VercelのMarketplaceから接続。環境変数は自動設定される）

const KEY = "thl_timetable_v1";

function kvEnv() {
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Redis(KV) の環境変数が設定されていません");
  return { url, token };
}

// Upstash REST APIにコマンドを1つ送る（例: ["GET","key"] / ["SET","key","value"]）
async function kv(cmd) {
  const { url, token } = kvEnv();
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error("KV error " + r.status);
  const j = await r.json();
  return j.result;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const raw = await kv(["GET", KEY]);
      if (!raw) return res.status(200).json({ exists: false });
      const data = JSON.parse(raw);
      return res.status(200).json({ exists: true, ...data });
    }

    if (req.method === "PUT") {
      // 編集パスワードの確認
      const tok = req.headers["x-edit-token"];
      if (!process.env.EDIT_TOKEN || tok !== process.env.EDIT_TOKEN) {
        return res.status(401).json({ error: "unauthorized" });
      }
      const body = req.body || {};

      // 競合検出：クライアントが読み込んだ時点(baseUpdatedAt)より
      // サーバーが新しければ、他の人が先に更新している
      const raw = await kv(["GET", KEY]);
      const cur = raw ? JSON.parse(raw) : null;
      if (cur && cur.updatedAt !== (body.baseUpdatedAt || null)) {
        return res
          .status(409)
          .json({ error: "conflict", updatedAt: cur.updatedAt });
      }

      const updatedAt = new Date().toISOString();
      const data = {
        lateRecords: Array.isArray(body.lateRecords) ? body.lateRecords : [],
        earlyEdits:
          body.earlyEdits && typeof body.earlyEdits === "object"
            ? body.earlyEdits
            : {},
        latePersons: Array.isArray(body.latePersons) ? body.latePersons : [],
        lateP: Array.isArray(body.lateP) ? body.lateP : [],
        updatedAt,
      };
      await kv(["SET", KEY, JSON.stringify(data)]);
      return res.status(200).json({ ok: true, updatedAt });
    }

    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res
      .status(500)
      .json({ error: String((e && e.message) || e) });
  }
}
