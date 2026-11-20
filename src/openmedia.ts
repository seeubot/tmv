export interface OpenResult {
  title: string;
  kind: "http" | "torrent";
  url?: string; // direct video URL (http)
  infoHash?: string; // torrent
}

// Blender Foundation open movies (CC-BY). Verify hashes against webtorrent.io before relying on them.
const OPEN_TORRENTS: OpenResult[] = [
  { title: "Sintel (Blender, CC-BY)", kind: "torrent", infoHash: "08ada5a7a6183aae1e09d831df6748d566095a10" },
  { title: "Big Buck Bunny (Blender, CC-BY)", kind: "torrent", infoHash: "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c" },
  { title: "Tears of Steel (Blender, CC-BY)", kind: "torrent", infoHash: "209c8226b299b308beaf2b9cd3fb49212dbd13ec" },
];

const IA = "https://archive.org";
const MAX_RESULTS = 10;

async function iaSearch(q: string): Promise<OpenResult[]> {
  // Strip characters that have meaning in Lucene query syntax.
  const safe = q.replace(/[^\p{L}\p{N}\s'-]/gu, " ").trim();
  if (!safe) return [];

  const query = `(${safe}) AND mediatype:movies AND (licenseurl:* OR collection:(feature_films OR opensource_movies))`;
  const u = new URL(`${IA}/advancedsearch.php`);
  u.searchParams.set("q", query);
  u.searchParams.append("fl[]", "identifier");
  u.searchParams.append("fl[]", "title");
  u.searchParams.set("rows", String(MAX_RESULTS));
  u.searchParams.set("output", "json");

  const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`archive.org search HTTP ${r.status}`);
  const docs: Array<{ identifier: string; title?: string }> = (await r.json()).response?.docs ?? [];

  const resolved = await Promise.all(
    docs.map(async (d): Promise<OpenResult | null> => {
      try {
        const m = await fetch(`${IA}/metadata/${encodeURIComponent(d.identifier)}`, {
          signal: AbortSignal.timeout(10_000),
        }).then((x) => x.json());

        const file = (m?.files ?? [])
          .filter((f: any) => /\.(mp4|webm|m4v)$/i.test(f.name) && f.source !== "metadata")
          .sort((a: any, b: any) => Number(a.size) - Number(b.size))[0]; // smallest = lightest
        if (!file) return null;

        return {
          title: String(d.title ?? d.identifier),
          kind: "http",
          url: `${IA}/download/${encodeURIComponent(d.identifier)}/${encodeURIComponent(file.name)}`,
        };
      } catch {
        return null;
      }
    }),
  );

  return resolved.filter((x): x is OpenResult => x !== null);
}

export async function searchOpen(q: string): Promise<OpenResult[]> {
  const needle = q.toLowerCase();
  const fixed = OPEN_TORRENTS.filter((t) => t.title.toLowerCase().includes(needle));
  const ia = await iaSearch(q).catch((err) => {
    console.error("[search] archive.org failed:", err instanceof Error ? err.message : err);
    return [] as OpenResult[];
  });
  return [...fixed, ...ia];
}
