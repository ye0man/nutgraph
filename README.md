# nutgraph

A knowledge graph of the Cashu ecosystem: the protocol spec at the center,
core modules and language bindings around it, and the wallets, mints, apps and
tools that depend on them in orbit.

The **dataset is the product**. The interactive visualization is one client of
it; release tooling and agent context are the others.

> **Live site: https://ye0man.github.io/nutgraph/**
>
> Status: **M4**. The pipeline emits the full graph (spec, NUTs, core libs,
> bindings, projects, **live mints**), with machine-derived version-aware
> dependencies and a static 2D radial viewer. Mint discovery uses NIP-87 relays,
> directories, and Tor-aware `/v1/info` probing.

## What it does

1. **Discovery** -- surface projects that are popular, fresh, and maintained,
   and show a newcomer what to actually go try.
2. **Release management** -- given a core library release, see every project
   that depends on it, which version they pin, and who may break.
3. **Context** -- a regenerated machine-readable bundle an agent can query.

## Architecture

```
1. INGEST     repos + services  -> raw metadata, manifests, registry data
2. RESOLVE    raw              -> canonical projects (nodes) + edges w/ provenance
3. SCORE      graph            -> metrics, rankings, staleness
4. BUILD      graph            -> graph.json + snapshots + agent bundle
```

Implemented: **ingest** of the awesome-cashu README, the NUTs spec, repo
metadata and manifests, and live mints (NIP-87 relays, directories, `/v1/info`
over clearnet/Tor); **resolve** of node identity, the NUT compatibility matrix,
version-aware dependencies, ranking, and mint→software edges; **build** of
`dist/graph.json`, dated snapshots, and `DATA_QUALITY.md`.

## The curation line

Humans curate the **ontology**; machines compute the **edges**.

- **Automated (no human):** dependencies, versions, stars/contributors/commits/
  releases, creation dates, mint `/v1/info` probes.
- **Curated (`ontology/`):** canonical project identity (repos, aliases, dedupe),
  node **type**, which things are core modules, which are bindings of which core.
- **Escape hatch (`overrides/edges.yaml`):** edges machine collection cannot see.

Litmus test: *if a field changes when the world changes, compute it; if it only
changes when our understanding changes, curate it.*

## Run it

```sh
npm install
npm run build                 # ingest -> resolve -> build -> dist/ + DATA_QUALITY.md + snapshot
npm run graph                 # pipeline summary only, writes nothing
npm run impact -- cashubtc/cashu-ts   # who depends on a lib, most-at-risk first
npm run typecheck
```

Set `GITHUB_TOKEN` (or have `gh` authenticated) for metadata. Mint discovery is
controlled by `NUTGRAPH_MINT_SOURCES` (`seed,directories,nostr`, default all)
and `NUTGRAPH_TOR_SOCKS` (e.g. `socks5h://127.0.0.1:9050`) to reach `.onion`
mints. Other test filters: `NUTGRAPH_REPOS=owner/a,owner/b`,
`NUTGRAPH_LIMIT=N`, `NUTGRAPH_MINT_LIMIT=N`. Network responses are cached under
`data/cache/`; pass `--refresh` to bypass.

### View the site

```sh
npm run build
npx serve site      # or: python -m http.server -d site
```

`npm run build` writes `site/graph.json`; the viewer is a self-contained static
page (d3 from CDN) that can be deployed to GitHub Pages. A nightly workflow
(`.github/workflows/nutgraph.yml`) rebuilds the graph, commits refreshed
outputs, and deploys the site.

## Repo layout

```
ontology/     curated: core.yaml, bindings.yaml, projects.yaml, packages.yaml, hosts.yaml
discovery/    curated: sources.yaml (mint discovery), mints-seed.yaml
overrides/    curated: edges.yaml (escape hatch)
src/hosts/    CodeHost adapter: github (forgejo -> M6)
src/ingest/   readme, nuts, manifests, registries, mints/ (nostr, directories, probe)
src/resolve/  packages, dependencies (depends_on + semver), versions
src/score/    profiles, rank (popularity/freshness/rings)
src/build/    graph compose, snapshots, agent bundle
site/         static 2D radial viewer (d3 from CDN)
.github/      nightly build + GitHub Pages deploy
dist/         generated output (gitignored)
snapshots/    dated graphs (growth animation + release diffs)
```

## Data-quality issue classes

The pipeline records every uncertainty rather than silently guessing. The
machine-generated ledger is [`DATA_QUALITY.md`](./DATA_QUALITY.md); this section
explains the *classes* so they can be fixed deliberately.

| Class | Cause | Impact | Fix |
| --- | --- | --- | --- |
| `README_NO_REPO` | Project listed only by a website/org URL (closed-source apps, hosted services, GitHub **org** pages). | No dependency edges are possible; the node is context-only. | Accepted by design for closed source. For open projects, add a repo override, or let M1's code-search tier try to find the source. |
| `README_DUPLICATE_ID` | One project appears in several README sections/roles. | Entries were merged into one node. | Confirm the merge; split via `ontology/projects.yaml` if the roles are genuinely distinct. |
| Documentation-site phantom nodes | The README's "Documentation Web Sites" section links doc domains that shadow a project. | A duplicate node with no repo. | Folded into the canonical project via aliases in `ontology/projects.yaml`; keep aliases current. |
| Org-only GitHub links | `github.com/<owner>` with no repo path. | Treated as a no-repo node, not an `org` node. | M1: detect, type as `org`, and link member repos. |
| Coarse unmaintained types | The unmaintained section has generic subsections. | Type defaulted to `app`. | Low impact (sinked by `status`); refine mapping if a specific type matters. |
| Non-project README entries | Decoders, simulators, status boards, testnut mints. | Nodes with no repo. | M1: section-aware filtering so only real projects become graph participants. |
| NUT list drift | NUT nodes are parsed from the `cashubtc/nuts` README. | If parsing breaks, a curated fallback is used and may be stale. | The ledger flags `NUTS_FETCH_FAILED`/`NUTS_FALLBACK_USED`; regenerate each run. |
| Implementer unmatched | The spec README credits a project with a NUT, but no node matched by URL/repo/alias. | A missing compatibility edge. | Add the project or an alias; logged as `NUT_IMPLEMENTER_UNMATCHED`. |
| `METADATA_MISSING` | Repo metadata fetch failed (transient GitHub 502, or repo moved/renamed). | No metrics/ranking for that node until a later run. | Re-run (failures aren't cached as empty); the retry/backoff usually clears it. |
| `PACKAGE_TARGET_MISSING` | A machine-read dependency maps to a node not in the graph. | The edge is dropped. | Add the project, or fix `ontology/packages.yaml`. |
| Dependency scope unlabelled | Manifests don't say whether a dep is runtime or dev/test. | A dev-only dependency looks like a real one. | M1.5: prefer `dependencies` over `devDependencies`; flag test-only edges. |
| Monorepo attribution | One repo backs several nodes (e.g. cdk + cdk-mintd). | Repo-level deps/metrics are attributed to the canonical (core) node only. | Documented; crate-level attribution is future work. |
| GitHub dependency-graph flakiness | The GraphQL dependency field returns 502s/empties under load. | Was the sole dep source; now only a fallback. | Primary source is direct manifest parsing (tier 1); GraphQL is a fallback for unparsed ecosystems (NuGet/Maven/Swift). |
| Semver `unknown` | Range is non-semver (git URL, `workspace:`, PR ref). | Lag not computed for that edge. | Expected; shown as `unknown`. |
| Mint software unknown | `/v1/info` rarely reports the implementation. | `runs` edges are sparse; some mints attach to the spec instead of their software. | Detection is name/version heuristics; add curated mappings or mint-side reporting. |
| Mint network junk | Some NIP-87 announcements put free text in the `n` tag. | Bad `network` values. | Sanitized to mainnet/testnet/signet/regtest; unknown → unset. |
| Relay/directory availability | Public Nostr relays or directory pages can be blocked/down (`NOSTR_UNAVAILABLE`, `DIRECTORY_UNREACHABLE`). | Fewer discovered mints that run. | Best-effort fan-in; seeds and other sources still apply. Add directories as needed. |
| `.onion` mints | Tor is not reachable without a SOCKS proxy. | Onion-only mints are skipped. | Set `NUTGRAPH_TOR_SOCKS`; CI installs and starts Tor. |
| Directory candidate noise | Directory pages link many non-mint hosts. | Extra probes (most fail `/v1/info`). | Probe is the gate; candidates are capped and cached. |

## Roadmap

- **M0** scaffold, schema v1, ontology, README + NUTs ingest, skeleton graph. *(done)*
- **M1** software dependency graph: direct manifest parsing (npm/crates/pypi/go/pub)
  + GitHub dependency-graph fallback, version-aware `depends_on` with semver lag,
  repo metrics, scoring + rank/ring, `impact` release report. *(done)*
- **M2** NUT axis: `implements` edges from live-mint `/v1/info` plus the spec README. *(done)*
- **M3** mint discovery: NIP-87 relays, directory fan-in, seed list, Tor-aware `/v1/info` probing, pubkey identity. *(done)*
- **M4** static 2D radial site: spec at center, NUT ring, core/binding rings, dependency orbit, detail panel, filters, search. *(done)*
- **M5** agent bundle + snapshots: `nodes/edges.jsonl`, `schema.md`, `manifest.json`, growth animation.
- **M6** Forgejo `CodeHost` adapter (git.cashu.dev).
