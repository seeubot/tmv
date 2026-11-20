import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const VLC_PATHS = [
  process.env.VLC_PATH,
  "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
  "C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe",
].filter(Boolean) as string[];

let cachedVlcPath: string | null = null;

function findVlc(): string | null {
  if (cachedVlcPath) return cachedVlcPath;
  for (const p of VLC_PATHS) {
    try {
      if (fs.existsSync(p)) {
        cachedVlcPath = p;
        return p;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

export interface VlcResult {
  ok: boolean;
  vlcPath?: string;
  error?: string;
}

/**
 * Spawn VLC detached so it survives server restarts.
 * `--no-one-instance` prevents it from glomming onto an existing VLC window.
 * `--started-from-file` skips the "no playlist" dialog.
 */
export function openInVlc(url: string): VlcResult {
  const vlc = findVlc();
  if (!vlc) {
    return {
      ok: false,
      error:
        "VLC not found. Install from https://www.videolan.org/vlc/ " +
        "or set VLC_PATH in .env.",
    };
  }

  try {
    const child = spawn(
      vlc,
      [
        "--no-one-instance",
        "--started-from-file",
        "--network-caching=3000",
        url,
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.unref();
    return { ok: true, vlcPath: vlc };
  } catch (err) {
    return {
      ok: false,
      vlcPath: vlc,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function vlcStatus(): { available: boolean; vlcPath?: string } {
  const vlc = findVlc();
  return { available: !!vlc, vlcPath: vlc ?? undefined };
}
