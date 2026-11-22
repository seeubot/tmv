import "dotenv/config";
import http from "node:http";
import { Readable } from "node:stream";
import { searchMovies, extractDownloadLinks } from "./india4movies.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length === 0) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderIndex());
      return;
    }

    // ---------- /search ----------
    if (parts[0] === "search") {
      const q = url.searchParams.get("q")?.trim();
      if (!q) { res.writeHead(400); res.end("missing q"); return; }
      const results = await searchMovies(q);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ results }));
      return;
    }

    // ---------- /links ----------
    if (parts[0] === "links") {
      const postUrl = url.searchParams.get("url");
      if (!postUrl) { res.writeHead(400); res.end("missing url"); return; }
      const links = await extractDownloadLinks(postUrl);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ links }));
      return;
    }

    // ---------- /details ----------
    if (parts[0] === "details") {
      let videoUrl = url.searchParams.get("url");
      if (!videoUrl) { res.writeHead(400); res.end("missing url"); return; }

      try {
        if (!videoUrl.match(/\.(mkv|mp4)/i)) {
          const playerRes = await fetch(videoUrl, { 
            headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://new.multicloudlinks.com/" } 
          });
          const html = await playerRes.text();
          
          let match = html.match(/const\s+streamSrc\s*=\s*["'](https?:\/\/[^"']+)["']/i) || html.match(/Video url:\s*(https?:\/\/[^\s"']+)/i);
          
          if (match && match[1]) {
            videoUrl = match[1];
          } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Could not find video link on page" }));
            return;
          }
          
          const titleMatch = html.match(/<title>(.*?)<\/title>/i);
          const title = titleMatch ? titleMatch[1].split('-')[0].trim() : "Unknown Movie";
          
          const thumbMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
          const thumbnail = thumbMatch ? thumbMatch[1] : "";

          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ title, thumbnail, directUrl: videoUrl }));
          return;
        } else {
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ title: "Direct Video", thumbnail: "", directUrl: videoUrl }));
          return;
        }
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ---------- /proxy ----------
    if (parts[0] === "proxy") {
      let videoUrl = url.searchParams.get("url");
      if (!videoUrl) { res.writeHead(400); res.end("missing url"); return; }

      try {
        if (!videoUrl.match(/\.(mkv|mp4)/i)) {
          const playerRes = await fetch(videoUrl, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://new.multicloudlinks.com/" } });
          const html = await playerRes.text();
          let match = html.match(/const\s+streamSrc\s*=\s*["'](https?:\/\/[^"']+)["']/i) || html.match(/Video url:\s*(https?:\/\/[^\s"']+)/i);
          if (match && match[1]) videoUrl = match[1];
        }

        const targetUrl = new URL(videoUrl);
        const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0", "Referer": targetUrl.origin + "/" };
        if (req.headers.range) headers["Range"] = req.headers.range;

        const upstream = await fetch(videoUrl, { headers });
        res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Access-Control-Allow-Origin", "*");
        
        const len = upstream.headers.get("content-length");
        const range = upstream.headers.get("content-range");
        if (len) res.setHeader("Content-Length", len);
        if (range) res.setHeader("Content-Range", range);

        res.writeHead(upstream.status);
        if (upstream.body) Readable.fromWeb(upstream.body as any).pipe(res);
        else res.end();
      } catch (err: any) {
        if (!res.headersSent) res.writeHead(502);
        res.end("Proxy error: " + err.message);
      }
      return;
    }

    res.writeHead(404); res.end("Not found");
  } catch (err: any) {
    if (!res.headersSent) res.writeHead(500);
    res.end("Server error: " + err.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`▶ Streamer listening on port ${PORT}`);
});

// ---------------------------------------------------------------- UI
function renderIndex(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Streamer Dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f0f10; color: #e8e8ea; padding: 2rem; max-width: 1100px; margin: auto; }
  h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
  .search-bar { display: flex; gap: 0.5rem; margin-bottom: 2rem; }
  input { flex: 1; padding: 12px 16px; border-radius: 8px; border: 1px solid #333; background: #1a1a1e; color: #fff; font-size: 16px; }
  button { padding: 12px 24px; border-radius: 8px; border: 0; background: #4a6cf7; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; }
  button:hover { background: #5a7cff; }
  
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
  .card { background: #1a1a1e; border-radius: 10px; padding: 1.5rem; border: 1px solid #2a2a30; transition: 0.2s; }
  .card:hover { border-color: #4a6cf7; }
  .card h3 { margin: 0 0 1rem 0; font-size: 1.1rem; line-height: 1.4; }
  .card button { width: 100%; background: #2a2a30; }
  .card button:hover { background: #4a6cf7; }

  #details-panel { display: none; background: #1a1a1e; border-radius: 12px; padding: 2rem; margin-bottom: 2rem; border-left: 5px solid #ff7a00; }
  .details-content { display: flex; gap: 2rem; align-items: flex-start; }
  .details-img { width: 200px; border-radius: 8px; object-fit: cover; }
  .details-text h2 { margin: 0 0 1rem 0; font-size: 1.4rem; }
  .btn-group { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1rem; max-width: 300px; }
  .btn-play { background: #10b981 !important; }
  .btn-play:hover { background: #059669 !important; }
  .btn-vlc { background: #ff7a00 !important; }
  .btn-vlc:hover { background: #ea580c !important; }
  
  #log { font-family: monospace; color: #888; margin-top: 1rem; font-size: 13px; white-space: pre-wrap; }
</style>
</head>
<body>
  <h1>Movie Streamer</h1>
  
  <div class="search-bar">
    <input type="text" id="q" placeholder="Search movie (e.g. Jailer)..." onkeydown="if(event.key==='Enter') search()">
    <button onclick="search()">Search</button>
  </div>

  <div id="details-panel">
    <div class="details-content">
      <img id="det-img" class="details-img" src="" alt="Poster" style="display:none">
      <div class="details-text">
        <h2 id="det-title">Title</h2>
        <p id="det-info" style="color: #aaa; font-size: 14px;"></p>
        <div class="btn-group">
          <button class="btn-play" onclick="playBrowser()">▶ Play in Web Player</button>
          <button class="btn-vlc" onclick="playVLC()">▶ Play in VLC</button>
        </div>
      </div>
    </div>
  </div>

  <div id="results" class="grid"></div>
  <div id="log"></div>

  <video id="player" controls style="width:100%; max-height:500px; background:#000; border-radius:8px; display:none; margin-top:2rem"></video>

<script>
const log = (msg) => { document.getElementById("log").innerText += "> " + msg + "\\n"; };
const resultsDiv = document.getElementById("results");
const detailsPanel = document.getElementById("details-panel");
let currentDirectUrl = "";

async function search() {
  const q = document.getElementById("q").value;
  resultsDiv.innerHTML = "Searching...";
  detailsPanel.style.display = "none";
  document.getElementById("player").style.display = "none";
  document.getElementById("log").innerText = "";
  
  try {
    const res = await fetch("/search?q=" + encodeURIComponent(q));
    const data = await res.json();
    if (!data.results || data.results.length === 0) { resultsDiv.innerHTML = "No results."; return; }
    
    resultsDiv.innerHTML = data.results.map((r, i) => 
      \`<div class="card">
        <h3>\${r.title}</h3>
        <button onclick="getLinks('\${r.postUrl}')">Get Links</button>
      </div>\`
    ).join("");
  } catch (e) { log("Search error: " + e.message); }
}

async function getLinks(postUrl) {
  log("Fetching links for movie...");
  try {
    const res = await fetch("/links?url=" + encodeURIComponent(postUrl));
    const data = await res.json();
    if (!data.links || data.links.length === 0) { log("No links found."); return; }
    
    const link = data.links[0].url;
    log("Link found. Fetching details...");

    const detRes = await fetch("/details?url=" + encodeURIComponent(link));
    const details = await detRes.json();
    
    if (details.error) { log("Detail error: " + details.error); return; }
    
    currentDirectUrl = details.directUrl;
    
    document.getElementById("det-title").innerText = details.title;
    document.getElementById("det-info").innerText = "Direct stream ready. Format: MKV/MP4";
    
    if (details.thumbnail) {
      document.getElementById("det-img").src = details.thumbnail;
      document.getElementById("det-img").style.display = "block";
    } else {
      document.getElementById("det-img").style.display = "none";
    }
    
    detailsPanel.style.display = "block";
    window.scrollTo({ top: 0, behavior: 'smooth' });
    
  } catch (e) { log("Error: " + e.message); }
}

function playBrowser() {
  const video = document.getElementById("player");
  video.style.display = "block";
  video.src = "/proxy?url=" + encodeURIComponent(currentDirectUrl);
  video.play().catch(e => log("Playback error: " + e.message));
}

function playVLC() {
  const title = document.getElementById("det-title").innerText;
  const url = currentDirectUrl;

  // 1. Mobile (Android) - Uses Android Intents to launch VLC
  if (/Android/i.test(navigator.userAgent)) {
    const cleanUrl = url.replace(/^https?:\\/\\//, '');
    const intentUrl = \`intent://\${cleanUrl}#Intent;scheme=https;package=org.videolan.vlc;S.title=\${encodeURIComponent(title)};end\`;
    
    log("Launching VLC on Android...");
    window.location.href = intentUrl;
    
    // Fallback to MX Player
    setTimeout(() => {
      window.location.href = \`intent://\${cleanUrl}#Intent;scheme=https;package=com.mxtech.videoplayer.ad;S.title=\${encodeURIComponent(title)};end\`;
    }, 2000);
    return;
  }

  // 2. Desktop (Windows/Mac) - Uses custom vlc:// protocol
  log("Attempting to launch VLC directly...");
  const vlcProtocolUrl = \`vlc://\${url}\`;
  
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.src = vlcProtocolUrl;
  document.body.appendChild(iframe);

  setTimeout(() => { document.body.removeChild(iframe); }, 1000);

  log("If VLC didn't open, it may not be installed, or your browser blocked the launch. Use the fallback button.");
  
  // Fallback download button
  const fallbackBtn = document.createElement("button");
  fallbackBtn.innerText = "Download .m3u Playlist (Fallback)";
  fallbackBtn.style.marginTop = "10px";
  fallbackBtn.onclick = () => {
    const m3uContent = "#EXTM3U\\n#EXTINF:-1," + title + "\\n" + url;
    const blob = new Blob([m3uContent], { type: "audio/x-mpegurl" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "Play_in_VLC.m3u";
    a.click();
  };
  
  const panel = document.getElementById("details-panel");
  if (!document.getElementById("fallback-vlc-btn")) {
    fallbackBtn.id = "fallback-vlc-btn";
    panel.appendChild(fallbackBtn);
  }
}
</script>
</body>
</html>`;
}
