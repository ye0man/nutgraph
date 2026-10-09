import type { Node, SourceRef } from "../schema.js";
import type { DataQualityLog } from "../data-quality.js";
import { fetchText } from "../util.js";

export const NUTS_README = "https://raw.githubusercontent.com/cashubtc/nuts/master/README.md";

export interface NutImplementerRef {
  label: string;
  url?: string;
}

export interface NutSpec {
  /** "NUT-07" */
  id: string;
  number: string;
  title: string;
  mandatory: boolean;
  /** wallet implementers, resolved from the spec README's link refs */
  wallets: NutImplementerRef[];
  /** mint implementers */
  mints: NutImplementerRef[];
}

/** Minimal fallback if the live spec repo is unreachable (cached copy usually covers this). */
const FALLBACK: Array<[string, string, boolean]> = [
  ["00", "Cryptography and Models", true],
  ["01", "Mint public keys", true],
  ["02", "Keysets and fees", true],
  ["03", "Swapping tokens", true],
  ["04", "Minting tokens", true],
  ["05", "Melting tokens", true],
  ["06", "Mint info", true],
  ["07", "Token state check", false],
  ["08", "Overpaid Lightning fees", false],
  ["09", "Signature restore", false],
  ["10", "Spending conditions", false],
  ["11", "Pay-To-Pubkey (P2PK)", false],
  ["12", "DLEQ proofs", false],
  ["13", "Deterministic secrets", false],
  ["14", "Hashed Timelock Contracts (HTLCs)", false],
  ["15", "Partial multi-path payments (MPP)", false],
  ["16", "Animated QR codes", false],
  ["17", "WebSocket subscriptions", false],
  ["18", "Payment requests", false],
  ["19", "Cached Responses", false],
  ["20", "Signature on Mint Quote", false],
  ["21", "Clear authentication", false],
  ["22", "Blind authentication", false],
  ["23", "Payment Method: BOLT11", false],
  ["24", "HTTP 402 Payment Required", false],
  ["25", "Payment Method: BOLT12", false],
  ["26", "Payment Request Bech32m Encoding", false],
  ["27", "Nostr Mint Backup", false],
  ["28", "Pay to Blinded Key (P2BK)", false],
  ["29", "Batched Mint", false],
  ["30", "Payment Method: Onchain", false],
];

function linkRefs(markdown: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(/^\[([^\]]+)\]:\s*(\S+)/);
    if (m) map.set((m[1] ?? "").toLowerCase(), m[2] ?? "");
  }
  return map;
}

function parseImplementers(cell: string, refs: Map<string, string>): NutImplementerRef[] {
  const out: NutImplementerRef[] = [];
  // Handles both full reference links `[Name][ref]` and shortcut links `[Name]`
  // (the spec README uses both).
  const re = /\[([^\]]+)\](?:\[([^\]]*)\])?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cell))) {
    const label = (m[1] ?? "").trim();
    if (!label || /^\d+$/.test(label)) continue;
    const ref = (m[2] || label).toLowerCase();
    out.push({ label, url: refs.get(ref) });
  }
  return out;
}

/**
 * Parse the Cashu NUTs spec README.
 *
 * This is the authoritative, machine-readable source for (a) the list of NUTs
 * and (b) which wallets/mints claim each NUT -- the raw material for the
 * compatibility matrix. It is regenerated every run so NUT nodes never drift.
 */
export function parseNuts(markdown: string, dq: DataQualityLog): NutSpec[] {
  const refs = linkRefs(markdown);
  const lines = markdown.split(/\r?\n/);
  const specs = new Map<string, NutSpec>();
  let mode: "mandatory" | "optional" | null = null;

  for (const line of lines) {
    if (/^###\s+Mandatory/i.test(line)) {
      mode = "mandatory";
      continue;
    }
    if (/^###\s+Optional/i.test(line)) {
      mode = "optional";
      continue;
    }
    if (/^#{2,4}\s+/.test(line)) {
      // any other heading ends the table region
      if (!/^###\s+(Mandatory|Optional)/i.test(line)) mode = null;
      continue;
    }
    if (!mode) continue;
    if (!line.trim().startsWith("|")) continue;

    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (!cells.length) continue;

    const numMatch = (cells[0] ?? "").match(/(\d{2})/);
    if (!numMatch) continue; // header / separator
    const number = numMatch[1]!;
    const id = `NUT-${number}`;
    const title = (cells[1] ?? "").trim();
    if (!title) continue;

    const mandatory = mode === "mandatory";
    const wallets = mandatory ? [] : parseImplementers(cells[2] ?? "", refs);
    const mints = mandatory ? [] : parseImplementers(cells[3] ?? "", refs);

    specs.set(id, { id, number, title, mandatory, wallets, mints });
  }

  if (specs.size === 0) {
    dq.add({
      code: "NUTS_FETCH_FAILED",
      severity: "warn",
      subject: "cashubtc/nuts",
      detail: "Parsed zero NUTs from the live spec README; using fallback list.",
    });
    for (const [number, title, mandatory] of FALLBACK) {
      specs.set(`NUT-${number}`, {
        id: `NUT-${number}`,
        number,
        title,
        mandatory,
        wallets: [],
        mints: [],
      });
    }
  }
  return [...specs.values()].sort((a, b) => a.number.localeCompare(b.number));
}

export async function fetchNuts(dq: DataQualityLog, refresh: boolean): Promise<NutSpec[]> {
  const text = await fetchText(NUTS_README, { refresh });
  if (!text) {
    dq.add({
      code: "FETCH_FAILED",
      severity: "warn",
      subject: "cashubtc/nuts README",
      detail: "Could not fetch the spec README; NUT nodes may be stale.",
    });
    return parseNuts("", dq);
  }
  return parseNuts(text, dq);
}

export function nutNodes(specs: NutSpec[]): Node[] {
  const source: SourceRef = {
    kind: "spec",
    ref: "cashubtc/nuts README",
    url: NUTS_README,
  };
  return specs.map((s) => ({
    id: s.id,
    type: "nut" as const,
    name: `NUT-${s.number}: ${s.title}`,
    host: "github",
    repos: ["cashubtc/nuts"],
    url: `https://github.com/cashubtc/nuts/blob/master/${s.number}.md`,
    description: s.title,
    status: "active" as const,
    aliases: [],
    tags: [s.mandatory ? "mandatory" : "optional"],
    nuts: [],
    sources: [source],
    metrics: {},
    scores: {},
  }));
}
