import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

const COLORS = {
  spec: "#ffd166",
  nut: "#4dd4c4",
  core_lib: "#ff8a5c",
  binding: "#ffb454",
  library: "#6ee7a8",
  wallet: "#5aa9ff",
  mint_software: "#b07cff",
  mint_instance: "#ff6bd6",
  app: "#93a1bd",
  tool: "#c9a26b",
  org: "#6b7a99",
};
const TYPE_LABEL = {
  spec: "Spec",
  nut: "NUT",
  core_lib: "Core lib",
  binding: "Binding",
  library: "Library",
  wallet: "Wallet",
  mint_software: "Mint software",
  mint_instance: "Mint",
  app: "App",
  tool: "Tool",
  org: "Org",
};
const RADIUS = { spec: 0, nutMandatory: 118, nutOptional: 200, core_lib: 300, binding: 388 };
const SAT_BASE = 476;
const SAT_STEP = 64;
const NEW_WINDOW_DAYS = 90;
const HIDE_AFTER_DAYS = 365;

const boot = document.getElementById("boot");
const svg = d3.select("#stage");
const panel = document.getElementById("panel");

let graph, nodeById, children, subtree, root, visible;
const state = { selected: null, hover: null, query: "", hiddenTypes: new Set() };

boot.textContent = "Loading graph…";

fetch("./graph.json")
  .then((r) => {
    if (!r.ok) throw new Error(`graph.json ${r.status}`);
    return r.json();
  })
  .then((g) => {
    graph = g;
    init();
    boot.classList.add("hidden");
  })
  .catch((err) => {
    boot.classList.add("error");
    boot.textContent = `Could not load ./graph.json — ${err.message}\nRun: npm run build`;
  });

function init() {
  nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  visible = new Set(graph.nodes.filter((n) => !isHidden(n)).map((n) => n.id));
  buildTree();
  draw();
  buildFilters();
  buildLegend();
  wireSearch();
  const hidden = graph.counts.nodes - visible.size;
  document.getElementById("stats").textContent =
    `${visible.size} shown · ${graph.counts.edges} edges` + (hidden > 0 ? ` · ${hidden} stale hidden` : "");
}

/** Projects with no meaningful activity for a year (or marked unmaintained /
 * archived) are hidden from the view but kept in the data (graph.json). */
function isHidden(n) {
  if (n.type === "spec" || n.type === "nut" || n.type === "core_lib" || n.type === "binding") {
    return false;
  }
  if (n.status === "archived" || n.status === "unmaintained") return true;
  const c = n.metrics && n.metrics.last_commit;
  if (c) {
    const days = (Date.now() - Date.parse(c)) / 86400000;
    if (days > HIDE_AFTER_DAYS) return true;
  }
  return false;
}

function buildTree() {
  children = new Map();
  for (const n of graph.nodes) {
    if (n.id === "spec" || n.type === "nut") continue;
    if (!visible.has(n.id)) continue;
    const parentId =
      n.primary_parent && visible.has(n.primary_parent) ? n.primary_parent : "spec";
    n._parent = parentId;
    const arr = children.get(parentId) ?? [];
    arr.push(n.id);
    children.set(parentId, arr);
  }
  subtree = new Map();
  const sizeOf = (id) => {
    if (subtree.has(id)) return subtree.get(id);
    let s = 1;
    for (const c of children.get(id) ?? []) s += sizeOf(c);
    subtree.set(id, s);
    return s;
  };
  for (const n of graph.nodes) if (visible.has(n.id)) sizeOf(n.id);

  root = nodeById.get("spec");
  root._angle = 0;
  root._radius = 0;
  const roots = (children.get("spec") ?? []).slice();
  roots.sort((a, b) => sizeOf(b) - sizeOf(a));
  const total = roots.reduce((s, id) => s + sizeOf(id), 0) || 1;
  let a = -Math.PI / 2;
  for (const id of roots) {
    const w = (2 * Math.PI * sizeOf(id)) / total;
    assignSubtrees(id, a, a + w);
    a += w;
  }
  // NUT ring: mandatory specs hug the core, optional specs sit just outside.
  const nuts = graph.nodes
    .filter((n) => n.type === "nut")
    .sort((x, y) => x.id.localeCompare(y.id));
  const placeRing = (arr, r) =>
    arr.forEach((n, i) => {
      n._angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, arr.length);
      n._radius = r;
    });
  placeRing(nuts.filter((n) => (n.tags || []).includes("mandatory")), RADIUS.nutMandatory);
  placeRing(nuts.filter((n) => !(n.tags || []).includes("mandatory")), RADIUS.nutOptional);
}

function assignSubtrees(id, a0, a1) {
  const node = nodeById.get(id);
  if (!node) return;
  node._angle = (a0 + a1) / 2;
  node._radius = radiusOf(node);
  const kids = (children.get(id) ?? []).slice();
  kids.sort((a, b) => (nodeById.get(b)?.scores?.rank ?? 0) - (nodeById.get(a)?.scores?.rank ?? 0));
  const total = kids.reduce((s, k) => s + subtree.get(k), 0) || 1;
  let a = a0;
  const pad = Math.min((a1 - a0) * 0.04, 0.01);
  for (const k of kids) {
    const w = ((a1 - a0 - pad * 2) * subtree.get(k)) / total;
    assignSubtrees(k, a + pad, a + pad + w);
    a += w;
  }
}

function radiusOf(n) {
  if (n.type === "core_lib") return RADIUS.core_lib;
  if (n.type === "binding") return RADIUS.binding;
  const ring = n.scores && n.scores.ring !== undefined ? n.scores.ring : 2;
  return SAT_BASE + ring * SAT_STEP;
}

function visualRadius(n) {
  if (n.id === "spec") return 24;
  if (n.type === "core_lib") return 16;
  if (n.type === "binding") return 10;
  if (n.type === "nut") return 7;
  const rank = n.scores && n.scores.rank !== undefined ? n.scores.rank : 0.1;
  return 4 + rank * 13;
}

function pos(n) {
  const r = n._radius ?? 0;
  const a = n._angle ?? 0;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

function isNew(n) {
  const c = n.created_at || (n.metrics && n.metrics.created_at);
  if (!c) return false;
  return (Date.now() - Date.parse(c)) / 86400000 < NEW_WINDOW_DAYS;
}

function hasBehind(n) {
  return graph.edges.some((e) => e.type === "depends_on" && e.from === n.id && e.lag === "behind_major");
}

let zoomLayer, linkSel, nodeSel, zoomBehavior;

function draw() {
  svg.selectAll("*").remove();
  const defs = svg.append("defs");
  const glow = defs.append("filter").attr("id", "glow");
  glow.append("feGaussianBlur").attr("stdDeviation", 3).attr("result", "b");
  const merge = glow.append("feMerge");
  merge.append("feMergeNode").attr("in", "b");
  merge.append("feMergeNode").attr("in", "SourceGraphic");

  zoomLayer = svg.append("g");
  linkSel = zoomLayer.append("g").attr("class", "links");
  nodeSel = zoomLayer.append("g").attr("class", "nodes");

  const paths = graph.edges
    .map((e) => ({ ...e, s: nodeById.get(e.from), t: nodeById.get(e.to) }))
    .filter(
      (e) =>
        e.s && e.t && e.type !== "maintained_by" && visible.has(e.from) && visible.has(e.to),
    );

  const link = linkSel
    .selectAll("line")
    .data(paths)
    .join("line")
    .attr("class", "link")
    .attr("x1", (d) => pos(d.s)[0])
    .attr("y1", (d) => pos(d.s)[1])
    .attr("x2", (d) => pos(d.t)[0])
    .attr("y2", (d) => pos(d.t)[1])
    .attr("stroke", (d) => linkColor(d))
    .attr("stroke-width", (d) => (d.type === "binding_of" ? 0.8 : d.role === "primary" ? 1.1 : 0.6))
    .attr("stroke-dasharray", (d) => (d.type === "binding_of" || d.type === "runs" ? "2 3" : null))
    .attr("opacity", (d) => linkOpacity(d));

  const nodes = graph.nodes.filter((n) => visible.has(n.id));
  const node = nodeSel
    .selectAll("g")
    .data(nodes, (d) => d.id)
    .join("g")
    .attr("class", "node")
    .attr("transform", (d) => {
      const [x, y] = pos(d);
      return `translate(${x},${y})`;
    })
    .on("mouseenter", (ev, d) => { state.hover = d.id; highlight(); tooltip(ev, d); })
    .on("mousemove", (ev) => moveTooltip(ev))
    .on("mouseleave", () => { state.hover = null; highlight(); hideTooltip(); })
    .on("click", (ev, d) => { ev.stopPropagation(); select(d); });

  node
    .append("circle")
    .attr("r", (d) => visualRadius(d))
    .attr("fill", (d) => COLORS[d.type] || "#888")
    .attr("fill-opacity", (d) => (isNew(d) || d.id === "spec" ? 1 : 0.85))
    .attr("stroke", (d) => (hasBehind(d) ? "#ff6b8a" : "#0a0d14"))
    .attr("stroke-width", (d) => (hasBehind(d) ? 2 : 1))
    .attr("filter", (d) => (d.id === "spec" || isNew(d) ? "url(#glow)" : null));

  node
    .append("text")
    .attr("x", (d) => visualRadius(d) + 4)
    .attr("y", 3)
    .attr("fill", "#cdd6e6")
    .attr("font-size", labelSize)
    .text((d) => shortName(d))
    .attr("opacity", (d) => (shouldLabel(d) ? 0.9 : 0));

  svg.on("click", () => select(null));

  zoomBehavior = d3
    .zoom()
    .scaleExtent([0.15, 8])
    .on("zoom", (ev) => zoomLayer.attr("transform", ev.transform));
  svg.call(zoomBehavior);
  // Start centered on the spec.
  svg.call(zoomBehavior.transform, d3.zoomIdentity);

  window.__links = link;
}

function labelSize(d) {
  if (d.id === "spec") return 14;
  if (d.type === "core_lib") return 12;
  if (d.type === "nut") return 10;
  return 10;
}
function shortName(d) {
  if (d.id === "spec") return "Cashu NUTs";
  if (d.type === "nut") return d.id.replace("NUT-", "");
  return d.name.length > 26 ? d.name.slice(0, 24) + "…" : d.name;
}
function shouldLabel(d) {
  if (d.id === "spec" || d.type === "core_lib" || d.type === "binding") return true;
  if (d.type === "nut" && d.id.endsWith("0")) return true;
  const rank = d.scores && d.scores.rank;
  return rank !== undefined && rank > 0.72;
}

function linkColor(d) {
  if (d.type === "binding_of") return "#ffb454";
  if (d.type === "implements") return "#2f6f78";
  if (d.type === "runs") return "#ff6bd6";
  return "#3a4763";
}
function linkOpacity(d) {
  if (d.type === "implements") return 0.16;
  if (d.type === "binding_of") return 0.7;
  if (d.type === "runs") return 0.5;
  return d.role === "primary" ? 0.5 : 0.18;
}

function neighbors(id) {
  const set = new Set([id]);
  for (const e of graph.edges) {
    if (e.from === id) set.add(e.to);
    if (e.to === id) set.add(e.from);
  }
  return set;
}

function highlight() {
  const active = state.hover || state.selected;
  if (!active) {
    nodeSel.selectAll(".node").attr("opacity", 1);
    linkSel.selectAll(".link").attr("opacity", (d) => linkOpacity(d));
    return;
  }
  const near = neighbors(active);
  nodeSel.selectAll(".node").attr("opacity", (d) => (near.has(d.id) ? 1 : 0.12));
  linkSel.selectAll(".link").attr("opacity", (d) =>
    d.from === active || d.to === active ? 0.85 : 0.04,
  );
}

function select(d) {
  state.selected = d ? d.id : null;
  nodeSel.selectAll(".node").classed("selected", (n) => n.id === state.selected);
  highlight();
  if (!d) {
    panel.classList.add("hidden");
    return;
  }
  renderPanel(d);
}

function renderPanel(d) {
  const m = d.metrics || {};
  const s = d.scores || {};
  const out = graph.edges.filter((e) => e.type === "depends_on" && e.from === d.id);
  const dependents = graph.edges.filter((e) => e.type === "depends_on" && e.to === d.id);
  const nuts = graph.edges.filter((e) => e.type === "implements" && e.from === d.id);
  const rows = [];

  rows.push(`<div class="type">${TYPE_LABEL[d.type] || d.type}${d.status && d.status !== "active" ? " · " + d.status : ""}</div>`);
  rows.push(`<h2>${esc(d.name)}</h2>`);
  if (isNew(d)) rows.push(`<div class="type" style="color:#6ee7a8">new</div>`);
  if (d.url) rows.push(`<div><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)}</a></div>`);
  if (d.description) rows.push(`<div class="desc">${esc(d.description)}</div>`);

  const metric = (k, v) => (v === undefined ? "" : `<div class="k">${k}</div><div class="v">${v}</div>`);
  const bits = [
    metric("stars", m.stars),
    metric("contributors", m.contributors),
    metric("forks", m.forks),
    metric("releases", m.releases),
    metric("last commit", m.last_commit ? ago(m.last_commit) : undefined),
    metric("last release", m.last_release ? ago(m.last_release) : undefined),
    metric("recommenders", m.recommenders),
    metric("network", d.network),
    metric("language", d.language),
  ].join("");
  if (bits) rows.push(`<div class="metrics">${bits}</div>`);

  if (s.rank !== undefined) {
    rows.push(scoreBar("popularity", s.popularity));
    rows.push(scoreBar("freshness", s.freshness));
    rows.push(scoreBar("rank", s.rank));
  }

  if (nuts.length) {
    rows.push(`<h3>Implements (${nuts.length})</h3><ul>${nuts
      .map((e) => `<li><span>${e.to}</span></li>`)
      .join("")}</ul>`);
  }
  if (out.length) {
    rows.push(`<h3>Depends on (${out.length})</h3><ul>${out
      .map(
        (e) =>
          `<li><span><a href="#" data-goto="${esc(e.to)}">${esc(nodeById.get(e.to)?.name || e.to)}</a></span><span class="lag ${e.lag || "unknown"}">${e.lag || "?"}</span></li>`,
      )
      .join("")}</ul>`);
  }
  if (dependents.length) {
    const behind = dependents.filter((e) => e.lag === "behind_major").length;
    rows.push(`<h3>Depended on by (${dependents.length})</h3>`);
    if (behind) rows.push(`<div class="desc">${behind} on a behind-major version.</div>`);
    rows.push(`<ul>${dependents
      .sort((a, b) => lagRank(a.lag) - lagRank(b.lag))
      .slice(0, 40)
      .map(
        (e) =>
          `<li><span><a href="#" data-goto="${esc(e.from)}">${esc(nodeById.get(e.from)?.name || e.from)}</a></span><span class="lag ${e.lag || "unknown"}">${e.lag || "?"}</span></li>`,
      )
      .join("")}</ul>`);
  }

  panel.innerHTML = rows.join("");
  panel.classList.remove("hidden");
  panel.querySelectorAll("[data-goto]").forEach((a) =>
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      const t = nodeById.get(a.getAttribute("data-goto"));
      if (t) {
        select(t);
        focusNode(t);
      }
    }),
  );
}
function lagRank(l) {
  return { behind_major: 0, behind_minor: 1, unknown: 2, up_to_date: 3 }[l] ?? 9;
}
function scoreBar(k, v) {
  if (v === undefined) return "";
  return `<div class="k">${k} <span style="float:right">${(v * 100).toFixed(0)}</span></div><div class="bar"><span style="width:${(v * 100).toFixed(0)}%"></span></div>`;
}
function ago(iso) {
  const d = (Date.now() - Date.parse(iso)) / 86400000;
  if (d < 1) return "today";
  if (d < 30) return `${Math.round(d)}d ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}
function focusNode(d) {
  const [x, y] = pos(d);
  const w = svg.node().clientWidth;
  const h = svg.node().clientHeight;
  const scale = 2.2;
  svg
    .transition()
    .duration(600)
    .call(
      zoomBehavior.transform,
      d3.zoomIdentity.translate(w / 2, h / 2).scale(scale).translate(-x, -y),
    );
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function buildFilters() {
  const types = [...new Set(graph.nodes.map((n) => n.type))].filter((t) => t !== "org");
  const el = document.getElementById("filters");
  el.innerHTML = types
    .map(
      (t) =>
        `<label><input type="checkbox" checked data-type="${t}"> ${TYPE_LABEL[t] || t}</label>`,
    )
    .join("");
  el.querySelectorAll("input").forEach((cb) =>
    cb.addEventListener("change", () => {
      if (cb.checked) state.hiddenTypes.delete(cb.dataset.type);
      else state.hiddenTypes.add(cb.dataset.type);
      applyFilters();
    }),
  );
}
function applyFilters() {
  nodeSel
    .selectAll(".node")
    .style("display", (d) => (state.hiddenTypes.has(d.type) ? "none" : null));
  linkSel
    .selectAll(".link")
    .style("display", (d) => (state.hiddenTypes.has(d.s.type) || state.hiddenTypes.has(d.t.type) ? "none" : null));
}

function buildLegend() {
  const el = document.getElementById("legend");
  const shown = ["spec", "nut", "core_lib", "binding", "library", "wallet", "mint_software", "mint_instance", "app", "tool"];
  el.innerHTML =
    `<div class="row" style="color:var(--ink);font-weight:600">Orbit by dependency</div>` +
    shown
      .map((t) => `<div class="row"><span class="sw" style="background:${COLORS[t]}"></span>${TYPE_LABEL[t]}</div>`)
      .join("") +
    `<div class="row" style="margin-top:6px">◉ glow = new (90d) · ◌ red ring = behind major</div>`;
}

function wireSearch() {
  const input = document.getElementById("search");
  input.addEventListener("input", () => {
    state.query = input.value.trim().toLowerCase();
    applySearch();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const hit = graph.nodes.find((n) =>
        (n.name + " " + n.id).toLowerCase().includes(state.query),
      );
      if (hit) {
        select(hit);
        focusNode(hit);
      }
    }
  });
}
function applySearch() {
  if (!state.query) {
    nodeSel.selectAll(".node").style("opacity", null);
    return;
  }
  nodeSel.selectAll(".node").style("opacity", (d) =>
    (d.name + " " + d.id + " " + (d.aliases || []).join(" ")).toLowerCase().includes(state.query)
      ? 1
      : 0.08,
  );
}

// ---- tooltip ----
let tip;
function tooltip(ev, d) {
  if (!tip) {
    tip = d3.select("body").append("div").attr("class", "tooltip");
  }
  const m = d.metrics || {};
  const bits = [];
  if (m.stars !== undefined) bits.push(`★ ${m.stars}`);
  if (m.contributors !== undefined) bits.push(`${m.contributors} contributors`);
  if (d.type === "nut" && d.tags) bits.push(d.tags.join(", "));
  tip.html(`<b>${esc(d.name)}</b><br><span style="color:var(--dim)">${TYPE_LABEL[d.type] || d.type}</span>${bits.length ? "<br>" + bits.join(" · ") : ""}`);
  moveTooltip(ev);
  tip.style("display", "block");
}
function moveTooltip(ev) {
  if (tip) tip.style("left", ev.clientX + 14 + "px").style("top", ev.clientY + 14 + "px");
}
function hideTooltip() {
  if (tip) tip.style("display", "none");
}
