import { Agent } from "undici";
import * as cheerio from "cheerio";

const BASE_URL = "https://go3.india4movies.click";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Ignore SSL errors and force HTTP/1.1 to prevent fetch failures on video hosts
const http1Agent = new Agent({ 
  allowH2: false,
  connect: {
    rejectUnauthorized: false 
  }
});

export interface MovieResult {
  title: string;
  postUrl: string;
}

export async function searchMovies(query: string): Promise<MovieResult[]> {
  const url = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
  const res = await fetch(url, { dispatcher: http1Agent, headers: { "User-Agent": UA } } as any);
  if (!res.ok) return [];
  
  const html = await res.text();
  const $ = cheerio.load(html);
  const results: MovieResult[] = [];

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    const title = $(el).text().trim();
    
    if (href && href.includes("india4movies.click") && 
        !href.includes("category") && !href.includes("?s=") && 
        title.length > 5) {
      results.push({ title, postUrl: href });
    }
  });

  return Array.from(new Map(results.map(item => [item.postUrl, item])).values());
}

export async function extractDownloadLinks(postUrl: string): Promise<{ quality: string, url: string }[]> {
  const postRes = await fetch(postUrl, { dispatcher: http1Agent, headers: { "User-Agent": UA } } as any);
  if (!postRes.ok) return [];
  
  const postHtml = await postRes.text();
  const $ = cheerio.load(postHtml);
  
  const finalLinks: { quality: string, url: string }[] = [];
  const potentialLinks: string[] = [];

  // 1. Find ALL external links that look like Watch or Download buttons
  $("a").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    
    if (href && (text.includes("Watch Online") || text.includes("Download Now")) && !href.includes("india4movies")) {
      potentialLinks.push(href);
    }
  });

  // 2. Visit every potential link and scrape it
  for (const link of potentialLinks) {
    console.log("[Extractor] Visiting:", link);
    try {
      const res = await fetch(link, { dispatcher: http1Agent, headers: { "User-Agent": UA } } as any);
      const html = await res.text();
      
      // Method A: The "Video url:" script variable
      const directMatch = html.match(/Video url:\s*(https?:\/\/[^\s"']+)/i);
      if (directMatch && directMatch[1]) {
        console.log("[Extractor] Found Direct Video:", directMatch[1]);
        finalLinks.push({ quality: "▶ Direct Stream", url: directMatch[1] });
        continue;
      }

      // Method B: Any raw .mkv, .mp4, .m3u8 link
      const rawMatch = html.match(/(https?:\/\/[^"'\s<>]+\.(?:mkv|mp4|m3u8)[^"'\s<>]*)/i);
      if (rawMatch && rawMatch[1]) {
        console.log("[Extractor] Found Raw Video:", rawMatch[1]);
        finalLinks.push({ quality: "▶ Raw Stream", url: rawMatch[1] });
        continue;
      }

      // Method C: An iframe
      const $html = cheerio.load(html);
      let iframeFound = false;
      $html("iframe").each((_, el) => {
        const src = $html(el).attr("src");
        if (src && src.startsWith("http") && !iframeFound) {
          console.log("[Extractor] Found Iframe:", src);
          finalLinks.push({ quality: "▶ Iframe Stream", url: src });
          iframeFound = true;
        }
      });
      if (iframeFound) continue;

      // Method D: Fallback for Multicloud view pages
      if (html.includes("multicloudlinks.com") || html.includes("player")) {
         finalLinks.push({ quality: "🔗 Open Manual Link", url: link });
      }

    } catch (e: any) {
      console.error("[Extractor] Failed to parse", link, e.message);
    }
  }

  // Deduplicate the final links
  return Array.from(new Map(finalLinks.map(item => [item.url, item])).values());
}
