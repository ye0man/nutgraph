import type { RawDependency } from "../hosts/types.js";
import { fetchOptionalText } from "../util.js";

const RAW = "https://raw.githubusercontent.com";

/**
 * Manifest filenames we know how to parse, tried at repo HEAD.
 * This is tier-1 dependency evidence (the highest trust: the repo's own source),
 * and it avoids relying on GitHub's flaky dependency-graph GraphQL field.
 */
export const MANIFESTS = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "pubspec.yaml",
  "build.gradle",
  "build.gradle.kts",
  "pom.xml",
] as const;

/** Basenames recognized when walking a repo tree (monorepos have nested manifests). */
export const MANIFEST_BASENAMES: ReadonlySet<string> = new Set(MANIFESTS);

export function isManifestPath(path: string): boolean {
  if (path.includes("node_modules/") || path.includes("/target/") || path.includes("/.git/")) {
    return false;
  }
  const base = path.split("/").pop() ?? "";
  return MANIFEST_BASENAMES.has(base);
}

export type ManifestFile = (typeof MANIFESTS)[number];

export async function fetchRepoDependencies(
  repo: string,
  refresh: boolean,
): Promise<RawDependency[]> {
  const results = await Promise.all(
    MANIFESTS.map(async (file) => {
      const text = await fetchOptionalText(`${RAW}/${repo}/HEAD/${file}`, { refresh });
      if (!text) return [];
      try {
        return parseManifest(file, text);
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}

export function parseManifest(file: string, text: string): RawDependency[] {
  const base = file.split("/").pop() ?? file;
  switch (base) {
    case "package.json":
      return parsePackageJson(text);
    case "Cargo.toml":
      return parseCargoToml(text);
    case "pyproject.toml":
      return parsePyproject(text);
    case "requirements.txt":
      return parseRequirements(text);
    case "go.mod":
      return parseGoMod(text);
    case "pubspec.yaml":
      return parsePubspec(text);
    case "build.gradle":
    case "build.gradle.kts":
      return parseGradle(text, file);
    case "pom.xml":
      return parsePom(text, file);
    default:
      return [];
  }
}

function dep(manager: string, name: string, requirements: string, manifest: string): RawDependency {
  return { manager, name: name.trim(), requirements: requirements.trim() || "*", manifest };
}

function parsePackageJson(text: string): RawDependency[] {
  const j = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  const out: RawDependency[] = [];
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const deps = j[section];
    if (!deps) continue;
    for (const [name, req] of Object.entries(deps)) {
      out.push(dep("npm", name, String(req), "package.json"));
    }
  }
  return out;
}

function parseCargoToml(text: string): RawDependency[] {
  const out: RawDependency[] = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1]!.trim();
      continue;
    }
    if (!/dependencies$/i.test(section)) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const name = m[1]!;
    const val = m[2]!.trim();
    let version = "*";
    if (val.startsWith("{")) {
      const vm = val.match(/version\s*=\s*"([^"]*)"/);
      if (vm) version = vm[1]!;
    } else {
      const q = val.match(/^"([^"]*)"/);
      if (q) version = q[1]!;
    }
    out.push(dep("crates", name, version, "Cargo.toml"));
  }
  return out;
}

function parsePyproject(text: string): RawDependency[] {
  const out: RawDependency[] = [];
  // PEP 621: dependencies = [ "cashu>=0.15", ... ]
  const arrayRe = /\bdependencies\s*=\s*\[([\s\S]*?)\]/g;
  let m: RegExpExecArray | null;
  while ((m = arrayRe.exec(text))) {
    for (const s of m[1]!.matchAll(/"([^"]+)"/g)) {
      const parsed = parseRequirementString(s[1]!);
      if (parsed) out.push(dep("pypi", parsed.name, parsed.req, "pyproject.toml"));
    }
  }
  // Poetry: [tool.poetry.dependencies] name = "^1.2"
  let inPoetry = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      inPoetry = /tool\.poetry\.(dev-)?dependencies/i.test(sec[1]!);
      continue;
    }
    if (!inPoetry) continue;
    const dm = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/);
    if (dm && dm[1]!.toLowerCase() !== "python") {
      out.push(dep("pypi", dm[1]!, dm[2]!, "pyproject.toml"));
    }
  }
  return out;
}

function parseRequirements(text: string): RawDependency[] {
  const out: RawDependency[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/#.*$/, "").trim();
    if (!line || line.startsWith("-") || line.startsWith("git+") || line.startsWith("http")) continue;
    line = line.replace(/\s*;.*$/, ""); // environment markers
    const m = line.match(/^([A-Za-z0-9_.-]+)(\[[^\]]*\])?\s*(.*)$/);
    if (!m) continue;
    out.push(dep("pypi", m[1]!, m[3] ?? "", "requirements.txt"));
  }
  return out;
}

function parseGoMod(text: string): RawDependency[] {
  const out: RawDependency[] = [];
  const lines = text.split(/\r?\n/);
  let inRequire = false;
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (/^require\s*\($/.test(line)) {
      inRequire = true;
      continue;
    }
    if (inRequire && line === ")") {
      inRequire = false;
      continue;
    }
    const single = line.match(/^require\s+(\S+)\s+(\S+)$/);
    if (single) {
      out.push(dep("go", single[1]!, single[2]!, "go.mod"));
      continue;
    }
    if (inRequire) {
      const m = line.match(/^(\S+)\s+(\S+)$/);
      if (m) out.push(dep("go", m[1]!, m[2]!, "go.mod"));
    }
  }
  return out;
}

function parsePubspec(text: string): RawDependency[] {
  const out: RawDependency[] = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    if (!line.trim()) continue;
    const top = line.match(/^([A-Za-z_]+):\s*$/);
    if (top) {
      section = top[1]!;
      continue;
    }
    if (section !== "dependencies" && section !== "dev_dependencies") continue;
    const m = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(.*)$/);
    if (m && m[2] !== undefined) out.push(dep("pub", m[1]!, m[2]!, "pubspec.yaml"));
  }
  return out;
}

function parseRequirementString(s: string): { name: string; req: string } | undefined {
  const m = s.match(/^([A-Za-z0-9_.-]+)(\[[^\]]*\])?\s*(.*)$/);
  if (!m) return undefined;
  return { name: m[1]!, req: m[3] ?? "" };
}

/** Gradle: pull `group:artifact[:version]` coordinates out of quoted strings. */
function parseGradle(text: string, manifest: string): RawDependency[] {
  const out: RawDependency[] = [];
  const re = /["']([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)(?::([^"'\s)]+))?["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push(dep("maven", `${m[1]}:${m[2]}`, m[3] ?? "*", manifest));
  }
  return out;
}

/** Maven POM: parse <dependency> blocks. */
function parsePom(text: string, manifest: string): RawDependency[] {
  const out: RawDependency[] = [];
  for (const block of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const b = block[1] ?? "";
    const g = b.match(/<groupId>([^<]+)<\/groupId>/)?.[1];
    const a = b.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1];
    const v = b.match(/<version>([^<]+)<\/version>/)?.[1];
    if (g && a) out.push(dep("maven", `${g}:${a}`, v ?? "*", manifest));
  }
  return out;
}
