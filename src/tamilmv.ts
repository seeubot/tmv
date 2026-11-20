import { Agent } from "undici";

const DEFAULT_BASES = ["https://www.1tamilmv.ceo"];

function getBaseUrls(): string[] {
  const fromEnv = process.env.TAMILMV_BASES ?? process.env.TAMILMV_BASE_URL;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean);
  }
  return DEFAULT_BASES;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const http1Agent = new Agent({
  allowH2: false,
  keepAliveTimeout: 5_000,
  keepAliveMaxTimeout: 10_000,
});

export interface SearchResult {
  title: string;
  topicUrl: string;
  magnet?: string;
  sizeHint?: string;
  quality?: string;
  audio?: string;
  languages?: string;
  raw: string;
}

function formatFetchError(url: string, err: unknown): string {
  const baseMsg = err instanceof Error ? err.message : String(err);
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
  const details = [code, causeMsg && causeMsg !== baseMsg ? causeMsg : ""]
    .filter(Boolean)
    .join(" — ");
  return `${url}: ${baseMsg}${details ? ` (${details})` : ""}`;
}

async function httpGet(
  url: string,
  timeoutMs = 12_000,
  retries = 1,
): Promise<{ html: string; finalUrl: string }> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        dispatcher: http1Agent,
        headers: {
          "User-Agent": UA,
          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": `${new URL(url).origin}/`,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} (${res.statusText}) for ${url}`);
      }

      return { html: await res.text(), finalUrl: res.url || url };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }

  throw lastErr;
}

function decodeHtmlText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&middot;/g, "·")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeMagnet(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&#x26;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseTitle(title: string): {
  sizeHint?: string;
  quality?: string;
  audio?: string;
  languages?: string;
} {
  const out: {
    sizeHint?: string;
    quality?: string;
    audio?: string;
    languages?: string;
  } = {};

  const q = title.match(
    /\b(4K|2160p|1080p|720p|480p|HQ|HD|FHD|WEB[- ]?DL|BluRay)\b/i,
  );
  if (q) out.quality = q[1].toUpperCase();

  const sz = title.match(/\b(\d+(?:\.\d+)?)\s*(GB|MB)\b/i);
  if (sz) out.sizeHint = `${sz[1]}${sz[2].toUpperCase()}`;

  const au = title.match(
    /(DD\+?[0-9.]+(?:\s*ATMOS)?(?:\s*[-–]\s*\d+\s*Kbps)?|AAC\s*[0-9.]+(?:\s*\d+\s*Kbps)?|DTS(?:-HD)?\s*[0-9.]*)/i,
  );
  if (au) out.audio = au[1].replace(/\s+/g, " ").trim();

  const lang = title.match(/\[(Tam|Tel|Hin|Mal|Kan|Eng)[^\]]*\]/i);
  if (lang) out.languages = lang[0].slice(1, -1);

  return out;
}

function extractTopicsFromHtml(
  html: string,
  baseUrl: string,
  filterQuery?: string,
): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const terms = (filterQuery ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const anchorRe =
    /<a\b[^>]*href=["']([^"']*(?:\/forums)?\/topic\/(\d+)-[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1];
    const id = m[2];
    if (id === "183") continue;
    if (seen.has(id)) continue;

    let text = decodeHtmlText(m[3]);

    const titleAttr = /title=["']([^"']+)["']/i.exec(m[0]);
    if (titleAttr) {
      const cleanedAttr = decodeHtmlText(titleAttr[1]).replace(
        /^View the topic\s+/i,
        "",
      );
      if (cleanedAttr.length > text.length) {
        text = cleanedAttr;
      }
    }

    if (
      !text ||
      /^\d+\s+repl(y|ies)$/i.test(text) ||
      /^languages?$/i.test(text)
    ) {
      continue;
    }

    if (terms.length > 0) {
      const hay = `${text} ${href}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
    }

    const meta = parseTitle(text);

    results.push({
      title: text,
      topicUrl: new URL(href, baseUrl).toString(),
      sizeHint: meta.sizeHint,
      quality: meta.quality,
      audio: meta.audio,
      languages: meta.languages,
      raw: text,
    });
    seen.add(id);

    if (results.length >= 40) break;
  }

  return results;
}

export async function searchTamilMV(query: string): Promise<SearchResult[]> {
  const bases = getBaseUrls();
  const failures: string[] = [];
  const encodedQ = encodeURIComponent(query);

  for (const base of bases) {
    const candidates = [
      { url: `${base}/search/?q=${encodedQ}`, filter: false },
      { url: `${base}/index.php?/search/&q=${encodedQ}&quick=1`, filter: false },
      { url: `${base}/`, filter: true },
    ];

    for (const candidate of candidates) {
      try {
        const { html, finalUrl } = await httpGet(candidate.url);
        const parsed = extractTopicsFromHtml(
          html,
          finalUrl,
          candidate.filter ? query : undefined,
        );
        if (parsed.length > 0) {
          return parsed;
        }
      } catch (err) {
        failures.push(formatFetchError(candidate.url, err));
      }
    }
  }

  if (failures.length > 0) {
    console.warn("[tamilmv] candidate warnings:", failures.join(" | "));
  }
  return [];
}

export async function magnetsFromTopic(
  topicUrl: string,
): Promise<{ magnet: string; label?: string }[]> {
  const { html } = await httpGet(topicUrl);
  const found: { magnet: string; label?: string }[] = [];
  const seenHashes = new Set<string>();

  const anchorRe =
    /<a\b[^>]*href=["']([^"']*magnet:\?[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const decoded = decodeMagnet(m[1]);
    const hash = /urn:btih:([a-fA-F0-9]+)/i.exec(decoded)?.[1]?.toLowerCase();
    if (!hash || seenHashes.has(hash)) continue;
    seenHashes.add(hash);
    const label = decodeHtmlText(m[2]);
    found.push({ magnet: decoded, label: label || undefined });
  }

  if (found.length === 0) {
    const rawRe = /magnet:\?xt=urn:btih:[A-Za-z0-9]+[^"'<>\s]*/gi;
    let r: RegExpExecArray | null;
    while ((r = rawRe.exec(html)) !== null) {
      const decoded = decodeMagnet(r[0]);
      const hash = /urn:btih:([a-fA-F0-9]+)/i.exec(decoded)?.[1]?.toLowerCase();
      if (!hash || seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      found.push({ magnet: decoded });
    }
  }

  return found;
}

export function hashFromMagnet(magnet: string): string | null {
  return /urn:btih:([a-fA-F0-9]{40})/i.exec(magnet)?.[1]?.toLowerCase() ?? null;
}
