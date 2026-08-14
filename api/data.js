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
      // tokenSet: サーバー側にEDIT_TOKENが設定されているか（診断用。値そのものは返さない）
      const tokenSet = !!process.env.EDIT_TOKEN;
      // パスワードが添えられている場合は、データの有無より先に必ず照合する
      // （空のときに照合を飛ばすと、誤ったパスワードでも「接続OK」に見えてしまうため）
      const tok = req.headers["x-edit-token"];
      if (tok) {
        if (!(process.env.EDIT_TOKEN && tok === process.env.EDIT_TOKEN)) {
          return res.status(401).json({ error: "unauthorized", tokenSet });
        }
      }

      const raw = await kv(["GET", KEY]);
      if (!raw) return res.status(200).json({ exists: false, tokenSet });
      const data = JSON.parse(raw);

      // 1) 編集パスワード付き（照合済み）→ 全データ（学生別を含む）
      if (tok) {
        return res.status(200).json({ exists: true, ...data });
      }

      // 2) 学生キー付き（?s=XXXX）→ クラス時間割 + 本人の学生データのみ
      const sKey = req.query && req.query.s ? String(req.query.s) : null;

      // 学期の公開設定。未設定なら「公開」とみなす（従来の動きを変えないため）
      const pub = (data.published && typeof data.published === "object")
        ? data.published : { early: true, late: true };
      const earlyPub = pub.early !== false;
      const latePub = pub.late !== false;

      // 未公開の学期は、閲覧者にはデータ自体を返さない（画面で隠すだけでは不十分なため）
      const base = {
        exists: true,
        year: typeof data.year === "number" ? data.year : null,
        config: data.config || null,
        published: { early: earlyPub, late: latePub },
        notice: data.notice || null,
        lateRecords: latePub ? (data.lateRecords || []) : [],
        earlyRecords: earlyPub ? (data.earlyRecords || []) : [],
        earlyEdits: earlyPub ? (data.earlyEdits || {}) : {},
        updatedAt: data.updatedAt || null,
      };
      if (sKey) {
        const stu = (data.latePersons || []).find((p) => p && p.key === sKey);
        if (!stu) {
          return res
            .status(200)
            .json({ ...base, latePersons: [], lateP: [], earlyP: [], student: false });
        }
        return res.status(200).json({
          ...base,
          latePersons: [stu],
          lateP: latePub ? (data.lateP || []).filter((r) => r && r.person === stu.name) : [],
          earlyP: earlyPub ? (data.earlyP || []).filter((r) => r && r.person === stu.name) : [],
          student: true,
        });
      }

      // 3) 公開（キー無し）→ クラス時間割のみ。学生データは返さない
      return res
        .status(200)
        .json({ ...base, latePersons: [], lateP: [], earlyP: [], studentsHidden: true });
    }

    if (req.method === "PUT") {
      // 編集パスワードの確認
      const tok = req.headers["x-edit-token"];
      if (!process.env.EDIT_TOKEN || tok !== process.env.EDIT_TOKEN) {
        return res
          .status(401)
          .json({ error: "unauthorized", tokenSet: !!process.env.EDIT_TOKEN });
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
      // ---- 保存できる量の上限チェック（誤操作や不具合で巨大なデータが入るのを防ぐ）----
      const LIMITS = {
        classRecords: 20000,   // クラス時間割のコマ数（前期・後期それぞれ）
        persons: 2000,         // 学生の人数
        personRecords: 40000,  // 学生別のコマ数（学期ごと）
        bytes: 4 * 1024 * 1024 // 保存する全体の大きさ（4MB）
      };
      const over = [];
      const cnt = (a) => (Array.isArray(a) ? a.length : 0);
      if (cnt(body.lateRecords) > LIMITS.classRecords) over.push("後半の時間割のコマ数");
      if (cnt(body.earlyRecords) > LIMITS.classRecords) over.push("前半の時間割のコマ数");
      if (cnt(body.latePersons) > LIMITS.persons) over.push("学生の人数");
      if (cnt(body.lateP) > LIMITS.personRecords) over.push("学生別のコマ数（後半）");
      if (cnt(body.earlyP) > LIMITS.personRecords) over.push("学生別のコマ数（前半）");
      if (over.length) {
        return res.status(413).json({
          error: "データが大きすぎます：" + over.join("、") + "が上限を超えています。",
          limits: LIMITS,
        });
      }

      const data = {
        notice:
          body.notice && typeof body.notice === "object"
            ? {
                text: String(body.notice.text || "").slice(0, 500),
                level: body.notice.level === "alert" ? "alert" : "info",
                until: String(body.notice.until || "").slice(0, 10),
              }
            : null,
        published:
          body.published && typeof body.published === "object"
            ? { early: body.published.early !== false, late: body.published.late !== false }
            : { early: true, late: true },
        config:
          body.config && typeof body.config === "object" ? body.config : null,
        year:
          typeof body.year === "number"
            ? body.year
            : parseInt(body.year, 10) || null,
        lateRecords: Array.isArray(body.lateRecords) ? body.lateRecords : [],
        earlyRecords: Array.isArray(body.earlyRecords) ? body.earlyRecords : [],
        earlyEdits:
          body.earlyEdits && typeof body.earlyEdits === "object"
            ? body.earlyEdits
            : {},
        latePersons: Array.isArray(body.latePersons) ? body.latePersons : [],
        lateP: Array.isArray(body.lateP) ? body.lateP : [],
        earlyP: Array.isArray(body.earlyP) ? body.earlyP : [],
        updatedAt,
      };
      // 変更履歴（誰がいつ、どこを変えたか）。直近50件だけ残す
      const editor = String(req.headers["x-editor-name"] || "").slice(0, 40);
      const prev = cur;   // 競合検出のときに読み込み済み
      const summarize = (d) => ({
        early: Array.isArray(d && d.earlyRecords) ? d.earlyRecords.length : 0,
        late: Array.isArray(d && d.lateRecords) ? d.lateRecords.length : 0,
        persons: Array.isArray(d && d.latePersons) ? d.latePersons.length : 0,
        personRecs:
          (Array.isArray(d && d.earlyP) ? d.earlyP.length : 0) +
          (Array.isArray(d && d.lateP) ? d.lateP.length : 0),
      });
      const before = summarize(prev), after = summarize(data);
      const changed = [];
      if (before.early !== after.early) changed.push(`前半 ${before.early}→${after.early}コマ`);
      if (before.late !== after.late) changed.push(`後半 ${before.late}→${after.late}コマ`);
      if (before.persons !== after.persons) changed.push(`学生 ${before.persons}→${after.persons}人`);
      if (before.personRecs !== after.personRecs) changed.push(`学生別 ${before.personRecs}→${after.personRecs}コマ`);
      if (JSON.stringify(prev && prev.config) !== JSON.stringify(data.config)) changed.push("設定を変更");
      if (JSON.stringify(prev && prev.published) !== JSON.stringify(data.published)) changed.push("公開状態を変更");
      if (JSON.stringify(prev && prev.notice) !== JSON.stringify(data.notice)) changed.push("お知らせを変更");
      if (prev && prev.year !== data.year) changed.push(`年度 ${prev.year}→${data.year}`);
      const hist = Array.isArray(prev && prev.history) ? prev.history : [];
      if (changed.length || !prev) {
        hist.unshift({ at: updatedAt, by: editor || "（名前未設定）", what: changed.join(" / ") || "作成" });
      }
      data.history = hist.slice(0, 50);

      const json = JSON.stringify(data);
      if (json.length > LIMITS.bytes) {
        return res.status(413).json({
          error: "データ全体が大きすぎます（上限 4MB）。不要なデータを整理してください。",
        });
      }
      await kv(["SET", KEY, json]);
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
