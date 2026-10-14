import type { DataQualityLog } from "../../data-quality.js";

/**
 * Minimal Nostr relay client for NIP-87 / NIP-60 mint discovery.
 *
 * NIP-87: kind 38172 = a mint's self-announcement (u=url, d=pubkey, nuts, n=net),
 *         kind 38000 = a user recommendation (d points at a mint pubkey).
 * NIP-60: kind 17375 = a wallet event whose `mint` tags reveal mints in active
 *         use. We aggregate the URLs only -- never any user linkage (privacy).
 *
 * Uses the global WebSocket (Node >= 22). Every relay is queried independently
 * with a hard timeout; per-relay reachability is reported so "no events" is
 * distinguishable from "the transport or relays were unusable".
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
  /** mint URLs seen in NIP-60 wallet events (URLs only, never user linkage) */
  walletMints: string[];
  relaysQueried: number;
  relaysReachable: number;
}

interface RelayResult {
  events: NostrEvent[];
  reachable: boolean;
}

function queryRelay(url: string, filter: Record<string, unknown>, timeoutMs: number): Promise<RelayResult> {
  return new Promise((resolve) => {
    const events: NostrEvent[] = [];
    let done = false;
    let reachable = false;
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
      resolve({ events, reachable });
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      ws = new WebSocket(url);
    } catch {
      resolve({ events, reachable: false });
      return;
    }
    ws.onopen = () => {
      reachable = true;
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
): Promise<{ events: NostrEvent[]; relaysReachable: number }> {
  const results = await Promise.all(relays.map((r) => queryRelay(r, filter, timeoutMs)));
  const byId = new Map<string, NostrEvent>();
  let relaysReachable = 0;
  for (const r of results) {
    if (r.reachable) relaysReachable++;
    for (const e of r.events) byId.set(e.id, e);
  }
  return { events: [...byId.values()], relaysReachable };
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
  const walletMints = new Set<string>();

  // The global WebSocket landed in Node 22. Fail loudly rather than silently
  // returning zero, so a zero result is never mistaken for "no mints out there".
  if (typeof WebSocket === "undefined") {
    dq.add({
      code: "NOSTR_UNAVAILABLE",
      severity: "info",
      subject: "NIP-87 relays",
      detail: `Global WebSocket is unavailable on Node ${process.version}; relay discovery skipped.`,
      suggestion: "Run on Node >= 22. Seed/directory sources still apply.",
    });
    return { announcements, recommenderCounts, walletMints: [], relaysQueried: relays.length, relaysReachable: 0 };
  }

  let events: NostrEvent[] = [];
  let relaysReachable = 0;
  try {
    ({ events, relaysReachable } = await queryRelays(relays, { kinds }));
  } catch (err) {
    dq.add({
      code: "NOSTR_UNAVAILABLE",
      severity: "info",
      subject: "NIP-87 relays",
      detail: `Could not query relays: ${(err as Error).message}`,
      suggestion: "Expected in restricted networks; seed mints cover the gap.",
    });
    return { announcements, recommenderCounts, walletMints: [], relaysQueried: relays.length, relaysReachable: 0 };
  }

  if (relays.length && relaysReachable === 0) {
    dq.add({
      code: "NOSTR_UNAVAILABLE",
      severity: "info",
      subject: "NIP-87 relays",
      detail: `None of ${relays.length} relays was reachable (blocked network or all down); 0 events is a transport result, not an empty landscape.`,
      suggestion: "Seed/directory sources still apply; add relays if coverage matters.",
    });
  }

  const recommendersByMint = new Map<string, Set<string>>();
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
    } else if (ev.kind === 17375) {
      // NIP-60 wallet event: collect mint URLs only; the pubkey is never stored.
      for (const t of ev.tags) {
        if (t[0] === "mint" && t[1]) walletMints.add(t[1]);
      }
    }
  }

  for (const [mint, set] of recommendersByMint) recommenderCounts.set(mint, set.size);
  dq.add({
    code: "NOSTR_DISCOVERY",
    severity: "info",
    subject: "NIP-87",
    detail: `${announcements.length} announcements, ${recommenderCounts.size} recommended mints, ${walletMints.size} mints in NIP-60 wallet events across ${relaysReachable}/${relays.length} reachable relay(s).`,
  });
  return { announcements, recommenderCounts, walletMints: [...walletMints], relaysQueried: relays.length, relaysReachable };
}
