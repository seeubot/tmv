import "dotenv/config";
import http from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import {
  resolveTorrent,
  pickFile,
  streamFile,
  DEFAULT_TRACKERS,
  VIDEO_EXTENSIONS,
  MIME_TYPES,
  client,
} from "./torrent.js";
import {
  searchTamilMV,
  magnetsFromTopic,
  hashFromMagnet,
} from "./tamilmv.js";
import { openInVlc, vlcStatus } from "./vlc.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const STREAM_HOST = process.env.STREAM_HOST ?? "127.0.0.1";
const MAX_MAGNETS_PER_TOPIC = Math.max(
  1,
  Number(process.env.MAX_MAGNETS_PER_TOPIC ?? 50),
);

// [PATCH] SSRF whitelist: only magnets or 40-char hex hashes are accepted.
// Block arbitrary URLs / file paths from reaching client.add().
function normalizeTorrentTarget(target: string): string {
  const t = target.trim();
  if (/^[a-fA-F0-9]{40}$/.test(t)) {
    const trs = DEFAULT_TRACKERS.map(
      (tr) => `&tr=${encodeURIComponent(tr)}`,
    ).join("");
    return `magnet:?xt=urn:btih:${t.toLowerCase()}${trs}`;
  }
  if (t.toLowerCase().startsWith("magnet:?")) {
    if (!hashFromMagnet(t)) {
      throw new Error("magnet has no valid btih infohash");
    }
    return t;
  }
  throw new Error(
    "only magnet: URIs or 40-char btih hashes are accepted",
  );
}

function formatError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause =
    err && typeof err === "object" && "cause" in err && err.cause
      ? err.cause
      : undefined;
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : "";
  const causeMsg =
    cause instanceof Error ? cause.message : cause ? String(cause) : "";
  const extra = [code, causeMsg && causeMsg !== base ? causeMsg : ""]
    .filter(Boolean)
    .join(" — ");
  return extra ? `${base} (${extra})` : base;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const parts = url.pathname.split("/").filter(Boolean);

    // ---------- GET / : embedded UI ----------
    if (parts.length === 0) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderIndex());
      return;
    }

    // ---------- GET /search?q= ----------
    if (parts[0] === "search") {
      const q = url.searchParams.get("q")?.trim();
      if (!q) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing ?q" }));
        return;
      }
      console.log(`[search] ${q}`);
      try {
        const results = await searchTamilMV(q);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ query: q, results }, null, 2));
      } catch (err) {
        const msg = formatError(err);
        console.error("[search] error:", msg);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    // ---------- GET /magnets?topic=<url> ----------
    if (parts[0] === "magnets") {
      const topicUrl = url.searchParams.get("topic");
      if (!topicUrl) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing ?topic" }));
        return;
      }
      console.log(`[magnets] ${topicUrl.slice(0, 90)}`);
      try {
        // [PATCH] cap number of magnets returned per topic
        const all = await magnetsFromTopic(topicUrl);
        const magnets = all.slice(0, MAX_MAGNETS_PER_TOPIC);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ topicUrl, magnets }, null, 2));
      } catch (err) {
        const msg = formatError(err);
        console.error("[magnets] error:", msg);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    // ---------- GET /media/<target>/files ----------
    if (parts[0] === "media" && parts[2] === "files" && parts[1]) {
      const target = decodeURIComponent(parts[1]);
      console.log(`[files] resolving ${target.slice(0, 80)}…`);
      // [PATCH] reject non-magnet targets before touching client.add()
      try {
        normalizeTorrentTarget(target);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: formatError(e) }));
        return;
      }
      const torrent = await resolveTorrent(target);
      const files = torrent.files.map((f, idx) => {
        const ext = extOf(f.name);
        return {
          idx,
          name: f.name,
          size: f.length,
          sizeHuman: humanSize(f.length),
          isVideo: VIDEO_EXTENSIONS.includes(ext),
          mime: MIME_TYPES[ext] ?? "application/octet-stream",
        };
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(
        JSON.stringify(
          { infoHash: torrent.infoHash, name: torrent.name, files },
          null,
          2,
        ),
      );
      return;
    }

    // ---------- GET /status/<hash> ----------
    if (parts[0] === "status" && parts[1]) {
      const torrent = client.get(parts[1]) as unknown as
        | {
            infoHash: string;
            name: string;
            ready: boolean;
            progress: number;
            downloadSpeed: number;
            uploadSpeed: number;
            numPeers: number;
            downloaded: number;
            length: number;
          }
        | undefined;
      if (!torrent) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "torrent not loaded" }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(
        JSON.stringify({
          infoHash: torrent.infoHash,
          name: torrent.name,
          ready: torrent.ready,
          progress: torrent.progress,
          downloadSpeed: torrent.downloadSpeed,
          uploadSpeed: torrent.uploadSpeed,
          numPeers: torrent.numPeers,
          downloaded: torrent.downloaded,
          length: torrent.length,
        }),
      );
      return;
    }

    // ---------- POST /play { magnet, idx? } ----------
    if (parts[0] === "play" && req.method === "POST") {
      const body = await readJsonBody(req);
      const magnet = String(body?.magnet ?? "").trim();
      const idxRaw = body?.idx;
      const fileIdx =
        idxRaw === undefined || idxRaw === null
          ? undefined
          : Number(idxRaw);

      if (!magnet) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing magnet" }));
        return;
      }

      // [PATCH] validate before resolveTorrent
      let normalized: string;
      try {
        normalized = normalizeTorrentTarget(magnet);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: formatError(e) }));
        return;
      }
      const hash = hashFromMagnet(normalized) ?? normalized;

      console.log(`[play] ${hash} idx=${fileIdx ?? "auto"}`);
      try {
        const torrent = await resolveTorrent(normalized);
        const file = pickFile(torrent, fileIdx);
        const streamUrl = `http://${STREAM_HOST}:${PORT}/stream/${torrent.infoHash}?idx=${torrent.files.indexOf(file)}`;

        // [PATCH] VLC is optional; on Docker/Render there is no binary.
        const vlc = openInVlc(streamUrl);
        const playerUrl = vlc.ok
          ? streamUrl
          : streamUrl; // same URL — browser <video> can also use it

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(
          JSON.stringify({
            infoHash: torrent.infoHash,
            fileName: file.name,
            fileSize: file.length,
            streamUrl,
            playerUrl, // [PATCH] new field for browser/remote playback
            vlc, // tells the frontend whether local VLC opened
          }),
        );
      } catch (err) {
        const msg = formatError(err);
        console.error("[play] error:", msg);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    // ---------- GET /vlc-status ----------
    if (parts[0] === "vlc-status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(vlcStatus()));
      return;
    }

    // ---------- GET /stream/<target>[?idx=N] ----------
    if (parts[0] === "stream" && parts[1]) {
      const target = decodeURIComponent(parts[1]);
      const idx = url.searchParams.get("idx");
      const fileIdx = idx != null ? Number(idx) : undefined;

      // [PATCH] CORS on /stream too — required for cross-origin <video>
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Expose-Headers",
        "Content-Range, Accept-Ranges, Content-Length, Content-Type",
      );

      // [PATCH] same SSRF guard as /media
      let normalized: string;
      try {
        normalized = normalizeTorrentTarget(target);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`Error: ${formatError(e)}`);
        return;
      }

      console.log(
        `[stream] resolving ${normalized.slice(0, 80)}… idx=${fileIdx ?? "auto"}`,
      );
      const torrent = await resolveTorrent(normalized);
      const file = pickFile(torrent, fileIdx);

      const abort = new AbortController();
      req.on("close", () => abort.abort());

      const response = streamFile(torrent, file, req.headers.range, abort.signal);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.writeHead(response.status);

      if (!response.body) {
        res.end();
        return;
      }
      const nodeStream = Readable.fromWeb(response.body as any, {
        highWaterMark: 1024 * 1024, // [PATCH] 1MB chunks — smoother 4K
      });
      nodeStream.pipe(res);
      nodeStream.on("error", (e) => {
        console.error("[stream] pipe error:", e);
        res.destroy();
      });
      // [PATCH] avoid hanging forever if client disconnects mid-stream
      await Promise.race([
        once(nodeStream, "end").catch(() => {}),
        once(res, "close").catch(() => {}),
      ]);
      return;
    }

    // ---------- GET /magnet/<hash> ----------
    if (parts[0] === "magnet" && parts[1]) {
      const tr = DEFAULT_TRACKERS.map(
        (t) => `&tr=${encodeURIComponent(t)}`,
      ).join("");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`magnet:?xt=urn:btih:${parts[1]}${tr}`);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    const msg = formatError(err);
    console.error("[server] error:", msg);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Error: ${msg}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`▶ torrent-stream listening on http://${HOST}:${PORT}`);
  console.log(`  UI:        http://${STREAM_HOST}:${PORT}/`);
  console.log(`  Search:    http://${STREAM_HOST}:${PORT}/search?q=jailer`);
  console.log(`  Stream:    http://${STREAM_HOST}:${PORT}/stream/<hash>?idx=N`);
  const st = vlcStatus();
  console.log(
    `  VLC:       ${st.available ? st.vlcPath : "NOT FOUND — browser playback will be used"}`,
  );
});

// ---------------------------------------------------------------- utils

function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------- UI
// Unchanged from your original — but you should now also expose a
// "Play in browser" button next to "Play in VLC" (uses /play → playerUrl).
function renderIndex(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>torrent-stream</title></head><body><h1>torrent-stream</h1><p>Open the UI you already have here, or fetch <code>/search?q=</code> directly.</p></body></html>`;
}
