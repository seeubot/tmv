export interface OpenResult {
  title: string;
  kind: "http" | "torrent";
  url?: string;        // direct video URL (http)
  infoHash?: string;   // torrent
}

// Verify these hashes against webtorrent.io / the Blender site before relying on them.
const OPEN_TORRENTS: OpenResult[] = [
  { title: "Sintel (Blender, CC-BY)", kind: "torrent", infoHash: "08ada5a7a6183aae1e09d831df6748d566095a10" },
  { title: "Big Buck Bunny (Blender, CC-BY)", kind: "torrent", infoHash: "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c" },
  { title: "Tears of Steel (Blender, CC-BY)", kind: "torrent", infoHash: "209c8226b299b308beaf2b9cd3fb49212dbd13ec" },
];

const IA = "https://archive.org";

async function iaSearch(q: string): Promise<OpenResult[]> {
  const query = `(${q}) AND mediatype:movies AND (licenseurl:* OR collection:(feature_films OR opensource_movies))`;
  const u = new URL(`${IA}/advancedsearch.php`);
  u.searchParams.set("q", query);
  u.searchParams.append("fl[]", "identifier");
  u.searchParams.append("fl[]", "title");
  u.searchParams.set("rows", "15");
  u.searchParams.set("output", "json");

  const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`archive.org search HTTP ${r.status}`);
  const docs = (await r.json()).response?.docs ?? [];

  const out: OpenResult[] = [];
  for (const d of docs) {
    const m = await fetch(`${IA}/metadata/${encodeURIComponent(d.identifier)}`, {
      signal: AbortSignal.timeout(10_000),
    }).then((x) => x.json()).catch(() => null);
    const file = m?.files
      ?.filter((f: any) => /\.(mp4|webm|m4v)$/i.test(f.name) && f.source !== "metadata")
      .sort((a: any, b: any) => Number(a.size) - Number(b.size))[0]; // smallest = lightest
    if (!file) continue;
    out.push({
      title: String(d.title),
      kind: "http",
      url: `${IA}/download/${encodeURIComponent(d.identifier)}/${encodeURIComponent(file.name)}`,
    });
  }
  return out;
}

export async function searchOpen(q: string): Promise<OpenResult[]> {
  const needle = q.toLowerCase();
  const fixed = OPEN_TORRENTS.filter((t) => t.title.toLowerCase().includes(needle));
  const ia = await iaSearch(q).catch(() => []);
  return [...fixed, ...ia];
}
