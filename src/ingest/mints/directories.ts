import type { DataQualityLog } from "../../data-quality.js";
import { fetchText } from "../../util.js";

interface DirectorySource {
  id: string;
  name?: string;
  url: string;
  enabled?: boolean;
}

/** Hosts that show up on directory pages but are never mint endpoints. */
const EXCLUDE_HOSTS = [
  "github.com",
  "gitlab.com",
  "git.cashu.dev",
  "x.com",
  "twitter.com",
  "nostr",
  "primal.net",
  "t.me",
  "discord",
  "youtube.com",
  "docs.google.com",
  "cashu.space",
  "bitcoinmints.com",
  "cashumints.space",
  "cashu.live",
  "mintradar.org",
  "wikipedia.org",
];

/**
 * Best-effort candidate extraction from directory pages: pull every host that
 * appears and let the /v1/info probe decide what is actually a mint. This is
 * deliberately permissive -- a candidate only needs ONE source to be tested,
 * and the probe is the gate.
 */
export async function discoverDirectories(
  sources: DirectorySource[],
  dq: DataQualityLog,
  refresh: boolean,
): Promise<string[]> {
  const found = new Set<string>();
  for (const src of sources) {
    if (src.enabled === false) continue;
    const text = await fetchText(src.url, { refresh });
    if (!text) {
      dq.add({
        code: "DIRECTORY_UNREACHABLE",
        severity: "info",
        subject: src.name ?? src.id,
        detail: `Could not fetch directory ${src.url}.`,
      });
      continue;
    }
    const before = found.size;
    for (const m of text.matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?/gi)) {
      try {
        const u = new URL(m[0]);
        const host = u.host.toLowerCase();
        if (EXCLUDE_HOSTS.some((x) => host === x || host.endsWith("." + x))) continue;
        found.add(`${u.protocol}//${u.host}`);
      } catch {
        /* ignore */
      }
    }
    dq.add({
      code: "DIRECTORY_SCANNED",
      severity: "info",
      subject: src.name ?? src.id,
      detail: `+${found.size - before} candidate host(s).`,
    });
  }
  return [...found];
}
