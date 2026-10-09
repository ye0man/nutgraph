import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const ROOT = resolve(process.cwd());
export const CACHE_DIR = join(ROOT, "data", "cache");
export const DIST_DIR = join(ROOT, "dist");

export function path(...parts: string[]): string {
  return join(ROOT, ...parts);
}

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readYaml<T = unknown>(p: string): Promise<T> {
  const raw = await readFile(p, "utf8");
  return parseYaml(raw) as T;
}

export async function readJson<T = unknown>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, "utf8")) as T;
}

export async function writeJson(p: string, data: unknown): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function writeText(p: string, data: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, data, "utf8");
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

export interface FetchOptions {
  /** bypass the on-disk cache */
  refresh?: boolean;
  /** return cached content if the network fails (default true) */
  offlineFallback?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Fetch a URL as text, with an on-disk cache under data/cache/.
 *
 * The cache exists for two reasons: (1) keep nightly runs inside API rate
 * limits and (2) make local iteration fast and offline-friendly. Every network
 * fact in the pipeline should go through here.
 */
export async function fetchText(
  url: string,
  opts: FetchOptions = {},
): Promise<string | undefined> {
  const { refresh = false, offlineFallback = true, headers = {}, timeoutMs = 30000 } = opts;
  const cacheFile = join(CACHE_DIR, `${sha1(url)}.txt`);

  if (!refresh && (await exists(cacheFile))) {
    return readFile(cacheFile, "utf8");
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { "user-agent": "nutgraph/0.0.1", ...headers },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile, text, "utf8");
    return text;
  } catch (err) {
    if (offlineFallback && (await exists(cacheFile))) {
      return readFile(cacheFile, "utf8");
    }
    console.warn(`[fetch] failed: ${url} -- ${(err as Error).message}`);
    return undefined;
  }
}

export async function fetchJson<T>(
  url: string,
  opts: FetchOptions = {},
): Promise<T | undefined> {
  const text = await fetchText(url, opts);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export function githubToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GH_PAT;
}
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Canonical node ids for repo-backed nodes are lowercased (GitHub owner/repo is
 * case-insensitive); synthetic ids like "NUT-07" or "spec" are left as-is.
 */
export function normalizeNodeId(id: string): string {
  return id.includes("/") ? id.toLowerCase() : id;
}

/** Extract owner/repo from a github.com URL, or undefined. */
export function githubRepoFromUrl(url: string): string | undefined {
  const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!m) return undefined;
  return `${m[1]}/${m[2]}`.replace(/\.git$/, "");
}

/** Extract owner/repo from a git.cashu.dev (forgejo) URL, or undefined. */
export function forgejoRepoFromUrl(url: string): string | undefined {
  const m = url.match(/^https?:\/\/git\.cashu\.dev\/([^/]+)\/([^/#?]+)/i);
  if (!m) return undefined;
  return `${m[1]}/${m[2]}`.replace(/\.git$/, "");
}

export function nowIso(): string {
  return new Date().toISOString();
}
