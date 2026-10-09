import type { DataQualityLog } from "../../data-quality.js";

/**
 * Minimal Nostr relay client for NIP-87 mint discovery.
 *
 * NIP-87: kind 38172 = a mint's self-announcement (u=url, d=pubkey, nuts, n=net),
 *         kind 38000 = a user recommendation (d points at a mint pubkey).
 *
 * Uses the global WebSocket (Node >= 22). Every relay is queried independently
 * with a hard timeout; failures are recorded and never fatal.
 */

export interface NostrEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface MintAnnouncement {
  url: string;
  pubkey?: string;
  network?: string;
  nuts?: number[];
  name?: string;
}

export interface NostrDiscovery {
  announcements: MintAnnouncement[];
  /** mint pubkey (lowercased) -> distinct recommender count */
  recommenderCounts: Map<string, number>;
}

function queryRelay(url: string, filter: Record<string, unknown>, timeoutMs: number): Promise<NostrEvent[]> {
  return new Promise((resolve) => {
    const events: NostrEvent[] = [];
    let done = false;
    let ws: WebSocket | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve(events);
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      ws = new WebSocket(url);
    } catch {
      resolve([]);
      return;
    }
    ws.onopen = () => {
      try {
        ws?.send(JSON.stringify(["REQ", "nutgraph-mints", filter]));
      } catch {
        finish();
      }
    };
    ws.onmessage = (msg: MessageEvent) => {
      try {
        const data = JSON.parse(String(msg.data)) as unknown[];
        if (data[0] === "EVENT" && data[2]) events.push(data[2] as NostrEvent);
        else if (data[0] === "EOSE") finish();
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onerror = () => finish();
    ws.onclose = () => finish();
  });
}

export async function queryRelays(
  relays: string[],
  filter: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<NostrEvent[]> {
  const results = await Promise.all(relays.map((r) => queryRelay(r, filter, timeoutMs)));
  const byId = new Map<string, NostrEvent>();
  for (const evts of results) for (const e of evts) byId.set(e.id, e);
  return [...byId.values()];
}

function tag(ev: NostrEvent, name: string): string | undefined {
  return ev.tags.find((t) => t[0] === name)?.[1];
}

export async function discoverNostr(
  relays: string[],
  kinds: number[],
  dq: DataQualityLog,
): Promise<NostrDiscovery> {
  const announcements: MintAnnouncement[] = [];
  const recommenderCounts = new Map<string, number>();
  const recommendersByMint = new Map<string, Set<string>>();

  let events: NostrEvent[] = [];
  try {
    events = await queryRelays(relays, { kinds });
  } catch (err) {
    dq.add({
      code: "NOSTR_UNAVAILABLE",
      severity: "info",
      subject: "NIP-87 relays",
      detail: `Could not query relays: ${(err as Error).message}`,
      suggestion: "Expected in restricted networks; seed mints cover the gap.",
    });
    return { announcements, recommenderCounts };
  }

  for (const ev of events) {
    if (ev.kind === 38172) {
      const url = tag(ev, "u");
      if (!url) continue;
      const nutsTag = tag(ev, "nuts");
      let name: string | undefined;
      try {
        name = (JSON.parse(ev.content) as { name?: string }).name;
      } catch {
        /* content may be empty */
      }
      announcements.push({
        url,
        pubkey: tag(ev, "d"),
        network: tag(ev, "n"),
        nuts: nutsTag
          ? nutsTag
              .split(",")
              .map((s) => Number(s.trim()))
              .filter((n) => Number.isFinite(n))
          : undefined,
        name,
      });
    } else if (ev.kind === 38000) {
      const d = (tag(ev, "d") ?? tag(ev, "a"))?.toLowerCase();
      if (!d) continue;
      (recommendersByMint.get(d) ?? recommendersByMint.set(d, new Set()).get(d)!).add(ev.pubkey);
    }
  }

  for (const [mint, set] of recommendersByMint) recommenderCounts.set(mint, set.size);
  dq.add({
    code: "NOSTR_DISCOVERY",
    severity: "info",
    subject: "NIP-87",
    detail: `Found ${announcements.length} mint announcements and ${recommenderCounts.size} recommended mints across ${relays.length} relays.`,
  });
  return { announcements, recommenderCounts };
}
