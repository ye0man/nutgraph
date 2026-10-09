import http from "node:http";
import https from "node:https";
import { SocksProxyAgent } from "socks-proxy-agent";

export interface MintInfo {
  url: string;
  pubkey: string;
  name?: string;
  version?: string;
  nuts: number[];
  motd?: string;
  tosUrl?: string;
  network?: string;
}

export interface ProbeOptions {
  timeoutMs?: number;
  /** e.g. "socks5h://127.0.0.1:9050" -- required to reach .onion mints */
  socksProxy?: string;
  networkHint?: string;
}

function normalize(url: string): string | undefined {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

/**
 * Probe a mint's NUT-06 /v1/info. Clearnet uses fetch; .onion requires a SOCKS
 * proxy (Tor). Returns undefined for anything that is not a live mint.
 */
export async function probeMint(rawUrl: string, opts: ProbeOptions = {}): Promise<MintInfo | undefined> {
  const { timeoutMs = 8000, socksProxy, networkHint } = opts;
  const url = normalize(rawUrl);
  if (!url) return undefined;

  const isOnion = new URL(url).hostname.endsWith(".onion");
  let text: string | undefined;
  if (isOnion) {
    if (!socksProxy) return undefined;
    text = await httpGet(`${url}/v1/info`, socksProxy, timeoutMs);
  } else {
    text = await fetchGet(`${url}/v1/info`, timeoutMs);
  }
  if (!text) return undefined;

  let info: {
    name?: string;
    pubkey?: string;
    version?: string;
    nuts?: Record<string, unknown>;
    motd?: string;
    tos_url?: string;
  };
  try {
    info = JSON.parse(text) as typeof info;
  } catch {
    return undefined;
  }
  if (!info.pubkey) return undefined;
  const nuts = Object.keys(info.nuts ?? {})
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n));

  return {
    url,
    pubkey: info.pubkey.toLowerCase(),
    name: info.name,
    version: info.version,
    nuts,
    motd: info.motd,
    tosUrl: info.tos_url,
    network: networkHint ?? (/testnut|test\./i.test(url) ? "testnet" : undefined),
  };
}

async function fetchGet(url: string, timeoutMs: number): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "nutgraph/0.0.1" } });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    return await res.text();
  } catch {
    return undefined;
  }
}

function httpGet(url: string, socksProxy: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let agent: http.Agent;
    try {
      agent = new SocksProxyAgent(socksProxy);
    } catch {
      resolve(undefined);
      return;
    }
    const mod: typeof http = url.startsWith("https") ? (https as unknown as typeof http) : http;
    const req = mod.get(url, { agent, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(undefined);
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    req.on("error", () => resolve(undefined));
    req.on("timeout", () => {
      req.destroy();
      resolve(undefined);
    });
  });
}
