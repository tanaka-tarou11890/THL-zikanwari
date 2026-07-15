/* THL 時間割ツール Service Worker
   方針：
   - 常にネットワーク優先（更新が必ず届く）。オフライン時のみキャッシュで表示
   - /api/ は一切キャッシュしない（時間割データは常に最新をサーバーから）
   - GET以外（保存のPUTなど）には関与しない
   - CACHE_VERSION を上げると古いキャッシュは自動削除される */
const CACHE_VERSION = "thl-tt-v1";
const SHELL = ["/", "/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                 // 保存(PUT)等は素通し
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // 外部CDN等は素通し
  if (url.pathname.startsWith("/api/")) return;     // APIは常にネットワーク・非キャッシュ

  e.respondWith(
    fetch(req)
      .then((res) => {
        // 成功したらキャッシュを更新（次のオフラインに備える）
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        // オフライン：キャッシュから返す。ページ遷移はクエリ違いも同一扱いで本体を返す
        caches.match(req, { ignoreSearch: req.mode === "navigate" })
          .then((m) => m || (req.mode === "navigate" ? caches.match("/") : Response.error()))
      )
  );
});
