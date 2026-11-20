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
// The URL VLC (or a remote VLC) should hit. If the server is on a LAN,
// use the PC's LAN IP here so VLC on another device can reach it too.
const STREAM_HOST = process.env.STREAM_HOST ?? "127.0.0.1";

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
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const parts = url.pathname.split("/").filter(Boolean);

    // ============================================================
    // GET /  →  Web UI
    // ============================================================
    if (parts.length === 0) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderIndex());
      return;
    }

    // ============================================================
    // GET /search?q=...  →  TamilMV results (JSON)
    // ============================================================
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

    // ============================================================
    // GET /magnets?topic=<url>  →  all magnets from a topic page
    // ============================================================
    if (parts[0] === "magnets") {
      const topicUrl = url.searchParams.get("topic");
      if (!topicUrl) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing ?topic" }));
        return;
      }
      console.log(`[magnets] ${topicUrl.slice(0, 90)}`);
      try {
        const magnets = await magnetsFromTopic(topicUrl);
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

    // ============================================================
    // GET /media/<target>/files  →  torrent file list (JSON)
    // ============================================================
    if (parts[0] === "media" && parts[2] === "files" && parts[1]) {
      const target = decodeURIComponent(parts[1]);
      console.log(`[files] resolving ${target.slice(0, 80)}…`);
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

    // ============================================================
    // GET /status/<hash>
    // ============================================================
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

    // ============================================================
    // POST /play  →  resolve torrent, pick file, spawn VLC
    // Body: { magnet, idx? }
    // ============================================================
    if (parts[0] === "play" && req.method === "POST") {
      const body = await readJsonBody(req);
      const magnet = String(body?.magnet ?? "").trim();
      const idxRaw = body?.idx;
      const fileIdx =
        idxRaw === undefined || idxRaw === null ? undefined : Number(idxRaw);

      if (!magnet) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing magnet" }));
        return;
      }
      const hash = hashFromMagnet(magnet) ?? magnet;

      console.log(`[play] ${hash} idx=${fileIdx ?? "auto"}`);
      try {
        const torrent = await resolveTorrent(magnet);
        const file = pickFile(torrent, fileIdx);
        const streamUrl = `http://${STREAM_HOST}:${PORT}/stream/${torrent.infoHash}?idx=${torrent.files.indexOf(file)}`;
        const vlc = openInVlc(streamUrl);
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
            vlc,
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

    // ============================================================
    // GET /vlc-status  →  VLC availability
    // ============================================================
    if (parts[0] === "vlc-status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(vlcStatus()));
      return;
    }

    // ============================================================
    // GET /stream/<target>[?idx=N]
    // ============================================================
    if (parts[0] === "stream" && parts[1]) {
      const target = decodeURIComponent(parts[1]);
      const idx = url.searchParams.get("idx");
      const fileIdx = idx != null ? Number(idx) : undefined;

      res.setHeader("Access-Control-Allow-Origin", "*");
      console.log(`[stream] resolving ${target.slice(0, 80)}… idx=${fileIdx ?? "auto"}`);
      const torrent = await resolveTorrent(target);
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
      const nodeStream = Readable.fromWeb(response.body as any);
      nodeStream.pipe(res);
      nodeStream.on("error", (e) => {
        console.error("[stream] pipe error:", e);
        res.destroy();
      });
      await once(nodeStream, "end").catch(() => {});
      return;
    }

    // ============================================================
    // GET /magnet/<hash>  →  build a magnet
    // ============================================================
    if (parts[0] === "magnet" && parts[1]) {
      const tr = DEFAULT_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
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
  console.log(`  VLC:       ${st.available ? st.vlcPath : "NOT FOUND — install VLC or set VLC_PATH in .env"}`);
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

// ---------------------------------------------------------------- HTML

function renderIndex(): string {
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
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
  .badge {
    font-size: 0.72rem; padding: 0.15rem 0.5rem; border-radius: 4px;
    background: #2a2a30; color: #9a9aa5;
  }
  .badge.quality { background: #4a6cf7; color: white; }
  .badge.size    { background: #2e7d32; color: white; }
  .badge.audio   { background: #b8860b; color: white; }
  .badge.lang    { background: #7b1fa2; color: white; }
  .result .actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .result .actions button {
    font-size: 0.8rem; padding: 0.4rem 0.85rem;
    background: #2a2a30;
  }
  .result .actions button.vlc { background: #ff7a00; }
  .result .actions button:hover { filter: brightness(1.15); }
  #log {
    margin-top: 1rem; font-family: monospace; font-size: 0.8rem;
    color: #9a9aa5; white-space: pre-wrap; background: #15151a;
    padding: 0.75rem; border-radius: 8px; min-height: 2rem;
    max-height: 300px; overflow-y: auto;
  }
  #log .ok   { color: #5fd35f; }
  #log .err  { color: #ff6b6b; }
  #log .info { color: #6f9bff; }
  .magnet-list {
    margin-top: 0.5rem; padding: 0.5rem 0.75rem; background: #15151a;
    border-radius: 6px; font-family: monospace; font-size: 0.75rem;
    color: #888; max-height: 160px; overflow-y: auto;
  }
  .magnet-list .magnet-row {
    padding: 0.35rem 0; border-bottom: 1px solid #222;
    display: flex; gap: 0.5rem; align-items: center;
  }
  .magnet-list .magnet-row:last-child { border-bottom: 0; }
  .magnet-list .magnet-row .label { flex: 1; color: #aaa; word-break: break-all; }
  .magnet-list .magnet-row button { font-size: 0.72rem; padding: 0.25rem 0.6rem; }
</style>
</head>
<body>
  <h1>torrent-stream</h1>

  <div class="row">
    <input type="text" id="q" placeholder="Search query… (e.g. jailer, 2026)" autocomplete="off">
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

async function search() {
  const q = $("q").value.trim();
  if (!q) return;
  $("results").innerHTML = "";
  $("go").disabled = true;
  log("searching for \\"" + q + "\\"…");
  try {
    const res = await fetch("/search?q=" + encodeURIComponent(q));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
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
  if (r.quality)   meta.appendChild(badge(r.quality, "quality"));
  if (r.sizeHint)  meta.appendChild(badge(r.sizeHint, "size"));
  if (r.audio)     meta.appendChild(badge(r.audio, "audio"));
  if (r.languages) meta.appendChild(badge(r.languages, "lang"));
  div.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "actions";

  const loadBtn = button("Load magnets", async () => {
    loadBtn.disabled = true;
    loadBtn.textContent = "Loading…";
    try {
      const res = await fetch("/magnets?topic=" + encodeURIComponent(r.topicUrl));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      const magnets = data.magnets || [];
      if (magnets.length === 0) {
        log("no magnets on this topic.", "err");
        return;
      }
      log(magnets.length + " magnet(s) extracted.", "ok");
      const box = document.createElement("div");
      box.className = "magnet-list";
      magnets.forEach((m) => {
        const row = document.createElement("div");
        row.className = "magnet-row";
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = m.label || (m.magnet.slice(0, 90) + "…");
        row.appendChild(label);
        row.appendChild(button("Play in VLC", () => playInVlc(m.magnet), "vlc"));
        row.appendChild(button("Inspect", () => inspect(m.magnet), ""));
        box.appendChild(row);
      });
      div.appendChild(box);
    } catch (err) {
      log("loading magnets failed: " + err.message, "err");
    } finally {
      loadBtn.disabled = false;
      loadBtn.textContent = "Load magnets";
    }
  });
  actions.appendChild(loadBtn);

  const openBtn = button("Open topic", () => window.open(r.topicUrl, "_blank"), "");
  actions.appendChild(openBtn);

  const directBtn = button("Magnet directly", async () => {
    directBtn.disabled = true;
    try {
      const res = await fetch("/magnets?topic=" + encodeURIComponent(r.topicUrl));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      const magnets = data.magnets || [];
      if (magnets.length === 0) throw new Error("no magnets on this topic.");
      const chosen = magnets[0].magnet;
      log("using first magnet: " + (magnets[0].label || chosen.slice(0, 80)), "info");
      await playInVlc(chosen);
    } catch (err) {
      log("direct magnet failed: " + err.message, "err");
    } finally {
      directBtn.disabled = false;
    }
  });
  actions.appendChild(directBtn);

  div.appendChild(actions);
  return div;
}

async function playInVlc(magnet) {
  log("requesting VLC playback…", "info");
  try {
    const res = await fetch("/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ magnet }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    log(
      "playing \\"" + (data.fileName || "stream") + "\\" → " + data.streamUrl,
      "ok",
    );
  } catch (err) {
    log("play failed: " + err.message, "err");
  }
}

async function inspect(magnet) {
  log("inspecting torrent files…", "info");
  try {
    const res = await fetch("/media/" + encodeURIComponent(magnet) + "/files");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    const files = data.files || [];
    log("torrent: " + (data.name || data.infoHash) + " (" + files.length + " file(s))", "ok");
    for (const f of files) {
      log("  [" + f.idx + "] " + f.name + " (" + f.sizeHuman + ")", "info");
    }
  } catch (err) {
    log("inspect failed: " + err.message, "err");
  }
}

function badge(text, cls) {
  const s = document.createElement("span");
  s.className = "badge" + (cls ? " " + cls : "");
  s.textContent = text;
  return s;
}

function button(label, onClick, cls) {
  const b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}
</script>
</body>
</html>`;
}
