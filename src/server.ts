import "dotenv/config";
import http from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import {
  resolveTorrent,
  pickFile,
  streamFile,
  toInfoHash,
  DEFAULT_TRACKERS,
  VIDEO_EXTENSIONS,
  MIME_TYPES,
  client,
} from "./torrent.js";
import { searchOpen } from "./openmedia.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

// Render sets RENDER_EXTERNAL_URL (public HTTPS). Fall back to local for dev.
const STREAM_PUBLIC_URL =
  process.env.RENDER_EXTERNAL_URL || `http://${process.env.STREAM_HOST || "127.0.0.1"}:${PORT}`;

// Only magnet URIs or 40-char hex infohashes are accepted (blocks SSRF via arbitrary URLs).
function normalizeTorrentTarget(target: string): string {
  const t = target.trim();
  if (/^[a-fA-F0-9]{40}$/.test(t)) {
    const trs = DEFAULT_TRACKERS.map((tr) => `&tr=${encodeURIComponent(tr)}`).join("");
    return `magnet:?xt=urn:btih:${t.toLowerCase()}${trs}`;
  }
  if (t.toLowerCase().startsWith("magnet:?")) {
    if (!toInfoHash(t)) throw new Error("magnet has no valid btih infohash");
    return t;
  }
  throw new Error("only magnet: URIs or 40-char btih hashes are accepted");
}

function formatError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = err && typeof err === "object" && "cause" in err && err.cause ? err.cause : undefined;
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : "";
  const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : "";
  const extra = [code, causeMsg && causeMsg !== base ? causeMsg : ""].filter(Boolean).join(" — ");
  return extra ? `${base} (${extra})` : base;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, cors = false): void {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cors) headers["Access-Control-Allow-Origin"] = "*";
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const parts = url.pathname.split("/").filter(Boolean);

    // ---------- GET / : embedded UI ----------
    if (parts.length === 0) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderIndex());
      return;
    }

    // ---------- GET /health ----------
    if (parts[0] === "health") {
      sendJson(res, 200, { ok: true, torrents: client.torrents.length });
      return;
    }

    // ---------- GET /search?q= ----------
    if (parts[0] === "search") {
      const q = url.searchParams.get("q")?.trim();
      if (!q) return sendJson(res, 400, { error: "missing ?q" });
      try {
        const results = await searchOpen(q);
        sendJson(res, 200, { query: q, results }, true);
      } catch (err) {
        sendJson(res, 500, { error: formatError(err) });
      }
      return;
    }

    // ---------- GET /media/<target>/files ----------
    if (parts[0] === "media" && parts[2] === "files" && parts[1]) {
      let normalized: string;
      try {
        normalized = normalizeTorrentTarget(decodeURIComponent(parts[1]));
      } catch (e) {
        return sendJson(res, 400, { error: formatError(e) });
      }
      try {
        const torrent = await resolveTorrent(normalized);
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
        sendJson(res, 200, { infoHash: torrent.infoHash, name: torrent.name, files }, true);
      } catch (err) {
        sendJson(res, 502, { error: formatError(err) });
      }
      return;
    }

    // ---------- GET /status/<hash> ----------
    if (parts[0] === "status" && parts[1]) {
      const hash = toInfoHash(decodeURIComponent(parts[1]));
      const torrent = hash ? (client.get(hash) as any) : null;
      if (!torrent || typeof torrent.then === "function") {
        return sendJson(res, 404, { error: "torrent not loaded" });
      }
      sendJson(
        res,
        200,
        {
          infoHash: torrent.infoHash,
          name: torrent.name,
          ready: torrent.ready,
          progress: torrent.progress,
          downloadSpeed: torrent.downloadSpeed,
          uploadSpeed: torrent.uploadSpeed,
          numPeers: torrent.numPeers,
          downloaded: torrent.downloaded,
          length: torrent.length,
        },
        true,
      );
      return;
    }

    // ---------- POST /play { magnet, idx? } ----------
    if (parts[0] === "play" && req.method === "POST") {
      let body: any;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { error: "invalid JSON body" });
      }
      const magnet = String(body?.magnet ?? "").trim();
      const idxRaw = body?.idx;
      const fileIdx = idxRaw === undefined || idxRaw === null ? undefined : Number(idxRaw);

      if (!magnet) return sendJson(res, 400, { error: "missing magnet" });

      let normalized: string;
      try {
        normalized = normalizeTorrentTarget(magnet);
      } catch (e) {
        return sendJson(res, 400, { error: formatError(e) });
      }

      try {
        // resolveTorrent has its own 30s metadata timeout and cleans up on failure.
        const torrent = await resolveTorrent(normalized, 30_000);
        const file = pickFile(torrent, fileIdx);
        const streamUrl = `${STREAM_PUBLIC_URL}/stream/${torrent.infoHash}?idx=${torrent.files.indexOf(file)}`;
        sendJson(
          res,
          200,
          { infoHash: torrent.infoHash, fileName: file.name, fileSize: file.length, streamUrl },
          true,
        );
      } catch (err) {
        console.error("[play] error:", err);
        sendJson(res, 502, { error: formatError(err) });
      }
      return;
    }

    // ---------- GET /stream/<target>[?idx=N] ----------
    if (parts[0] === "stream" && parts[1]) {
      const idx = url.searchParams.get("idx");
      const fileIdx = idx != null ? Number(idx) : undefined;

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Expose-Headers",
        "Content-Range, Accept-Ranges, Content-Length, Content-Type",
      );

      let normalized: string;
      try {
        normalized = normalizeTorrentTarget(decodeURIComponent(parts[1]));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`Error: ${formatError(e)}`);
        return;
      }

      let torrent;
      try {
        torrent = await resolveTorrent(normalized);
      } catch (e) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`Error: ${formatError(e)}`);
        return;
      }
      const file = pickFile(torrent, fileIdx);

      // Abort when the client goes away. (res "close", not req "close": on modern Node
      // req "close" can fire as soon as the request body is read.)
      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) abort.abort();
      });

      const response = streamFile(torrent, file, req.headers.range, abort.signal);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.writeHead(response.status);

      if (!response.body) {
        res.end();
        return;
      }

      const nodeStream = Readable.fromWeb(response.body as any, { highWaterMark: 64 * 1024 });
      nodeStream.on("error", (e) => {
        console.error("[stream] pipe error:", e);
        res.destroy();
      });
      nodeStream.pipe(res);

      await Promise.race([
        once(nodeStream, "end").catch(() => {}),
        once(res, "close").catch(() => {}),
      ]);
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
  console.log(`  UI: ${STREAM_PUBLIC_URL}/`);
});

// ---------------------------------------------------------------- utils

function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0,
    n = bytes;
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

function readJsonBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
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
function renderIndex(): string {
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>torrent-stream</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #0e0e10; color: #e8e8ea; margin: 0; padding: 2rem;
    max-width: 1100px; margin-inline: auto;
  }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  .row { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  input[type=text] {
    flex: 1; background: #1a1a1e; color: inherit; border: 1px solid #2a2a30;
    border-radius: 8px; padding: 0.75rem 1rem; font-size: 0.95rem;
  }
  button {
    background: #4a6cf7; color: #fff; border: 0; border-radius: 8px;
    padding: 0.75rem 1.25rem; cursor: pointer; font-weight: 600;
  }
  button:hover { background: #5a7cff; }
  button:disabled { background: #333; color: #777; cursor: not-allowed; }
  .result {
    padding: 0.85rem 1rem; background: #1a1a1e; border-radius: 8px;
    margin-bottom: 0.6rem; border: 1px solid transparent;
  }
  .result:hover { border-color: #4a6cf7; }
  .result .title { font-size: 0.92rem; margin-bottom: 0.5rem; line-height: 1.4; }
  .result .meta { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.6rem; }
  .badge { font-size: 0.72rem; padding: 0.15rem 0.5rem; border-radius: 4px; background: #2a2a30; color: #9a9aa5; }
  .badge.http { background: #2e7d32; color: #fff; }
  .badge.torrent { background: #4a6cf7; color: #fff; }
  .result .actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .result .actions button { font-size: 0.8rem; padding: 0.4rem 0.85rem; background: #ff7a00; }
  .result .actions button:hover { filter: brightness(1.15); }
  video { width: 100%; max-height: 500px; margin-top: 10px; border-radius: 8px; background: #000; }
  #log {
    margin-top: 1rem; font-family: monospace; font-size: 0.8rem;
    color: #9a9aa5; white-space: pre-wrap; background: #15151a;
    padding: 0.75rem; border-radius: 8px; min-height: 2rem;
    max-height: 240px; overflow-y: auto;
  }
  #log .ok   { color: #5fd35f; }
  #log .err  { color: #ff6b6b; }
  #log .info { color: #6f9bff; }
</style>
</head>
<body>
  <h1>torrent-stream</h1>

  <div class="row">
    <input type="text" id="q" placeholder="Search open-license films… (e.g. sintel, night of the living dead)" autocomplete="off">
    <button id="go">Search</button>
  </div>
  <div id="log">Ready.</div>
  <div id="results" style="margin-top:1rem"></div>

<script>
const $ = (id) => document.getElementById(id);
const log = (msg, cls = "info") => {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = "> " + msg;
  $("log").appendChild(el);
  $("log").scrollTop = $("log").scrollHeight;
};

$("go").addEventListener("click", search);
$("q").addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });

async function readJson(res) {
  const type = res.headers.get("content-type") || "";
  if (!type.includes("application/json")) {
    const text = await res.text();
    throw new Error("HTTP " + res.status + " " + text.slice(0, 120));
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

async function search() {
  const q = $("q").value.trim();
  if (!q) return;
  $("results").innerHTML = "";
  $("go").disabled = true;
  log("searching for \\"" + q + "\\"…");
  try {
    const data = await readJson(await fetch("/search?q=" + encodeURIComponent(q)));
    const results = data.results || [];
    if (results.length === 0) {
      log("no results. try a shorter query.", "err");
    } else {
      log("found " + results.length + " result(s).", "ok");
      for (const r of results) $("results").appendChild(renderResult(r));
    }
  } catch (err) {
    log("search failed: " + err.message, "err");
  } finally {
    $("go").disabled = false;
  }
}

function renderResult(r) {
  const div = document.createElement("div");
  div.className = "result";

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = r.title;
  div.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.appendChild(badge(r.kind === "http" ? "direct (archive.org)" : "torrent", r.kind));
  div.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "actions";

  if (r.kind === "http") {
    actions.appendChild(button("Play", () => {
      attachVideo(div, r.url);
      log("playing directly from archive.org (no server load).", "ok");
    }));
  } else if (r.kind === "torrent") {
    actions.appendChild(button("Play", (e) => playStream(r.infoHash, div, e.currentTarget)));
  }

  div.appendChild(actions);
  return div;
}

function attachVideo(container, src) {
  const old = container.querySelector("video");
  if (old) old.remove();
  const video = document.createElement("video");
  video.controls = true;
  video.autoplay = true;
  video.src = src;
  container.appendChild(video);
}

async function playStream(magnet, container, btn) {
  log("requesting stream… this can take up to 30 seconds.", "info");
  btn.disabled = true;
  try {
    const data = await readJson(await fetch("/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ magnet }),
    }));
    log("stream ready: " + data.fileName, "ok");
    attachVideo(container, data.streamUrl);
  } catch (err) {
    log("stream failed: " + err.message, "err");
  } finally {
    btn.disabled = false;
  }
}

function badge(text, cls) {
  const s = document.createElement("span");
  s.className = "badge" + (cls ? " " + cls : "");
  s.textContent = text;
  return s;
}

function button(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
</script>
</body>
</html>`;
}
