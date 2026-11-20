import WebTorrent from "webtorrent";
import type { Torrent, TorrentFile } from "webtorrent";
import crypto from "node:crypto";
import path from "node:path";

// ------------------------------------------------------------ config

const TORRENT_PATH = process.env.TORRENT_PATH
  ? path.resolve(process.env.TORRENT_PATH)
  : path.resolve("./tmp");
const IDLE_TTL_MS = Number(process.env.TORRENT_IDLE_TTL_MS ?? 45_000);
const MAX_ACTIVE_TORRENTS = Math.max(1, Number(process.env.MAX_ACTIVE_TORRENTS ?? 1));
const MAX_RANGE_BYTES = Math.max(256 * 1024, Number(process.env.MAX_RANGE_BYTES ?? 8 * 1024 * 1024));
export const MAX_STREAM_FILE_BYTES = Number(
  process.env.MAX_STREAM_FILE_BYTES ?? 1_610_612_736, // 1.5 GB
);

const opts = {
  maxConns: Number(process.env.MAX_CONNS ?? 12),
  peerId: crypto.randomBytes(20),
  nodeId: crypto.randomBytes(20),
  tracker: true,
  dht: false,
  utp: false,
  webSeeds: true,
  uploadLimit: 50 * 1024, // bytes/s
  downloadLimit: 4 * 1024 * 1024, // bytes/s
};

export const client = new WebTorrent(opts as any);

client.on("error", (err) => {
  console.error("WebTorrent client error:", err instanceof Error ? err.message : String(err));
});

const TORRENT_OPTS = {
  deselect: true,
  destroyStoreOnDestroy: true,
  path: TORRENT_PATH,
  addUID: true,
  storeCacheSlots: 2,
};

export const VIDEO_EXTENSIONS = [".mkv", ".mp4", ".avi", ".webm", ".mov", ".m4v", ".wmv"];

export const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".wmv": "video/x-ms-wmv",
};

export const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://explodie.org:6969/announce",
  "http://tracker.opentrackr.org:1337/announce",
  // WebRTC trackers let browser/web-seed peers be found
  "wss://tracker.webtorrent.dev",
  "wss://tracker.openwebtorrent.com",
];

// ------------------------------------------------------------ helpers

function isDestroyed(torrent: Torrent): boolean {
  return Boolean((torrent as unknown as { destroyed?: boolean }).destroyed);
}

function isTorrent(obj: unknown): obj is Torrent {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as any).once === "function" &&
    typeof (obj as any).on === "function" &&
    typeof (obj as any).removeListener === "function"
  );
}

async function unwrapTorrent(maybe: unknown): Promise<Torrent | null> {
  if (maybe == null) return null;
  const resolved =
    typeof (maybe as any).then === "function" ? await (maybe as Promise<unknown>) : maybe;
  return isTorrent(resolved) ? resolved : null;
}

/** Extract a 40-char hex infohash from a hash or magnet URI (sync, no parse-torrent needed). */
export function toInfoHash(target: string): string | null {
  const t = target.trim();
  if (/^[a-fA-F0-9]{40}$/.test(t)) return t.toLowerCase();
  const m = t.match(/^magnet:\?.*?xt=urn:btih:([a-fA-F0-9]{40})(?:&|$)/i);
  return m ? m[1].toLowerCase() : null;
}

function normalizeTorrentTarget(target: string): string {
  const t = target.trim();
  if (/^[a-fA-F0-9]{40}$/.test(t)) {
    const trs = DEFAULT_TRACKERS.map((tr) => `&tr=${encodeURIComponent(tr)}`).join("");
    return `magnet:?xt=urn:btih:${t.toLowerCase()}${trs}`;
  }
  return t;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

// ------------------------------------------------ lifecycle state

interface TorrentState {
  torrent: Torrent;
  lastAccess: number;
  activeStreams: number;
  timer?: NodeJS.Timeout;
}

const torrentStates = new Map<string, TorrentState>();
const torrentPromises = new Map<string, Promise<Torrent>>();

function scheduleCleanup(state: TorrentState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
  if (state.activeStreams > 0) return;

  const delay = Math.max(0, state.lastAccess + IDLE_TTL_MS - Date.now());
  state.timer = setTimeout(() => {
    state.timer = undefined;
    if (state.activeStreams > 0) return;
    void destroyTorrent(state.torrent.infoHash);
  }, delay);
  state.timer.unref?.();
}

function registerTorrent(torrent: Torrent): void {
  if (isDestroyed(torrent)) return;
  if (torrent.pieces.length > 0) torrent.deselect(0, torrent.pieces.length - 1, 0);
  // make sure nothing else in the torrent is being fetched
  for (const f of torrent.files) f.deselect();
  const state: TorrentState = { torrent, lastAccess: Date.now(), activeStreams: 0 };
  torrentStates.set(torrent.infoHash, state);
  scheduleCleanup(state);
}

function touchTorrent(torrent: Torrent): void {
  const state = torrentStates.get(torrent.infoHash);
  if (!state) return;
  state.lastAccess = Date.now();
  scheduleCleanup(state);
}

export function beginStream(torrent: Torrent): void {
  const state = torrentStates.get(torrent.infoHash);
  if (!state) return;
  state.activeStreams += 1;
  state.lastAccess = Date.now();
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
}

export function endStream(torrent: Torrent): void {
  const state = torrentStates.get(torrent.infoHash);
  if (!state) return;
  state.activeStreams = Math.max(0, state.activeStreams - 1);
  state.lastAccess = Date.now();
  scheduleCleanup(state);
}

function evictIdleTorrent(): boolean {
  let victim: TorrentState | undefined;
  for (const state of torrentStates.values()) {
    if (state.activeStreams > 0) continue;
    if (!victim || state.lastAccess < victim.lastAccess) victim = state;
  }
  if (!victim) return false;
  void destroyTorrent(victim.torrent.infoHash);
  return true;
}

function ensureCapacity(): void {
  let guard = 0;
  while (torrentStates.size >= MAX_ACTIVE_TORRENTS) {
    if (++guard > 32) break;
    if (!evictIdleTorrent()) break;
  }
}

// ------------------------------------------------ resolve torrent

export async function resolveTorrent(torrentId: string, timeoutMs = 30_000): Promise<Torrent> {
  const target = normalizeTorrentTarget(torrentId);
  const infoHash = toInfoHash(torrentId);

  if (infoHash) {
    const existing = await unwrapTorrent(client.get(infoHash) as unknown);
    if (existing) {
      const ready = existing.ready ? existing : await waitForTorrentReady(existing, timeoutMs);
      if (torrentStates.has(ready.infoHash)) touchTorrent(ready);
      else registerTorrent(ready);
      return ready;
    }
  }

  const inFlight = torrentPromises.get(target);
  if (inFlight) return inFlight;

  const promise = (async () => {
    let torrent: Torrent | undefined;
    try {
      ensureCapacity();
      const added = (await client.add(target, TORRENT_OPTS as any)) as unknown;
      const unwrapped = await unwrapTorrent(added);
      if (!unwrapped) throw new Error("client.add() did not return a Torrent object");
      torrent = unwrapped;
      const ready = await waitForTorrentReady(torrent, timeoutMs);
      registerTorrent(ready);
      return ready;
    } catch (err) {
      if (torrent && !isDestroyed(torrent)) void destroyTorrent(torrent.infoHash);
      throw err;
    } finally {
      torrentPromises.delete(target);
    }
  })();

  torrentPromises.set(target, promise);
  return promise;
}

function waitForTorrentReady(torrent: Torrent, timeoutMs: number): Promise<Torrent> {
  if (torrent.ready) return Promise.resolve(torrent);

  return new Promise<Torrent>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      torrent.removeListener("ready", onReady);
      torrent.removeListener("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve(torrent);
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timeout (${timeoutMs / 1000}s) waiting for torrent metadata. Ensure the torrent has active seeders.`,
        ),
      );
    }, timeoutMs);

    torrent.once("ready", onReady);
    torrent.once("error", onError);
    if (torrent.ready) onReady();
  });
}

// ------------------------------------------------ pick a file

export function pickFile(torrent: Torrent, fileIdx?: number): TorrentFile {
  if (fileIdx != null && !isNaN(fileIdx)) {
    const file = torrent.files[fileIdx];
    if (file) return file;
  }
  const videos = torrent.files.filter((f) => VIDEO_EXTENSIONS.includes(extOf(f.name)));
  const candidates = videos.length > 0 ? videos : torrent.files;
  if (candidates.length === 0) throw new Error("Torrent contains no files");
  return candidates.reduce((a, b) => (b.length > a.length ? b : a));
}

// ------------------------------------------------ stream (Range, clamped)

export function streamFile(
  torrent: Torrent,
  file: TorrentFile,
  rangeHeader?: string,
  signal?: AbortSignal,
): Response {
  const size = file.length;

  if (MAX_STREAM_FILE_BYTES > 0 && size > MAX_STREAM_FILE_BYTES) {
    return new Response(`File too large to stream (${size} > ${MAX_STREAM_FILE_BYTES})`, {
      status: 413,
    });
  }

  const match = rangeHeader?.match(/bytes=(\d*)-(\d*)/);
  let start = 0;
  let end = size - 1;
  let status = 200;

  if (match) {
    if (!match[1] && match[2]) {
      start = Math.max(0, size - parseInt(match[2], 10));
      end = size - 1;
    } else {
      start = match[1] ? parseInt(match[1], 10) : 0;
      end = match[2] ? Math.min(parseInt(match[2], 10), size - 1) : size - 1;
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    status = 206;
  }

  // Only ever serve a bounded window. The player asks for the next chunk as it plays,
  // so the swarm fetches roughly MAX_RANGE_BYTES ahead of the playhead, never the whole file.
  if (end - start + 1 > MAX_RANGE_BYTES) {
    end = start + MAX_RANGE_BYTES - 1;
    status = 206;
  }

  const headers = new Headers({
    "Content-Type": MIME_TYPES[extOf(file.name)] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type",
  });
  if (status === 206) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

  const fileAny = file as unknown as {
    stream?: (o: { start: number; end: number }) => ReadableStream<Uint8Array>;
    createReadStream?: (o: { start: number; end: number }) => ReadableStream<Uint8Array>;
  };
  const streamFn = fileAny.stream ?? fileAny.createReadStream;
  if (!streamFn) throw new Error("TorrentFile has no stream/createReadStream method");

  const reader = streamFn.call(file, { start, end }).getReader();

  beginStream(torrent);

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", onAbort);
    endStream(torrent);
  };
  const onAbort = () => {
    finish();
    void reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });

  return new Response(body, { status, headers });
}

// ------------------------------------------------ destroy

export async function destroyTorrent(torrentId: string): Promise<void> {
  const infoHash = toInfoHash(torrentId);
  const torrent = await unwrapTorrent(client.get(infoHash ?? torrentId) as unknown);
  if (!torrent) return;

  const state = torrentStates.get(torrent.infoHash);
  if (state && state.activeStreams > 0) {
    state.lastAccess = Date.now();
    scheduleCleanup(state);
    return;
  }

  if (state?.timer) clearTimeout(state.timer);
  torrentStates.delete(torrent.infoHash);

  try {
    await client.remove(torrent.infoHash, { destroyStore: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("No torrent with id")) console.error("Failed to remove torrent:", message);
  }
}
