import { escapeHtml } from "../../core/helpers.js";
import { getMassCombatRelationTags, getMassCombatTagCounters } from "./tag-config.js";
import { asNumber } from "./rules.js";

function safeClass(value) {
  return String(value ?? "").replace(/[^a-z0-9_-]/gi, "-");
}

function edgeGeometry(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const edgeLen = Math.round(Math.sqrt(dx * dx + dy * dy));
  const angle = Math.round(Math.atan2(dy, dx) * 10000 / Math.PI * 180) / 10000;
  return { edgeLen, angle };
}

function lineGeometry(x1, y1, x2, y2, startTrim = 0, endTrim = 0) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  const sx = x1 + dx / len * startTrim;
  const sy = y1 + dy / len * startTrim;
  const ex = x2 - dx / len * endTrim;
  const ey = y2 - dy / len * endTrim;
  const edgeDx = ex - sx;
  const edgeDy = ey - sy;
  return {
    x: Math.round(sx),
    y: Math.round(sy),
    l: Math.max(1, Math.round(Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy))),
    a: Math.round(Math.atan2(edgeDy, edgeDx) * 10000 / Math.PI * 180) / 10000,
    mx: Math.round((sx + ex) / 2),
    my: Math.round((sy + ey) / 2)
  };
}

function number(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function graphPositions(nodes, { width, height, cx, cy, radius }) {
  return new Map(nodes.map((node, index) => {
    const angle = (-Math.PI / 2) + (Math.PI * 2 * index / nodes.length);
    return [node.key, {
      x: Math.round(cx + Math.cos(angle) * radius),
      y: Math.round(cy + Math.sin(angle) * radius),
      labelX: Math.round(cx + Math.cos(angle) * (radius + 4)),
      labelY: Math.round(cy + Math.sin(angle) * (radius + 4)),
      width,
      height
    }];
  }));
}

function graphEdges(nodes, positions) {
  const nodeMap = new Map(nodes.map((node) => [node.key, node]));
  const edges = [];
  for (const [sourceKey, targets] of Object.entries(getMassCombatTagCounters() ?? {})) {
    if (!nodeMap.has(sourceKey)) continue;
    for (const [targetKey, value] of Object.entries(targets ?? {})) {
      if (!nodeMap.has(targetKey)) continue;
      const a = positions.get(sourceKey);
      const b = positions.get(targetKey);
      if (sourceKey === targetKey) {
        const x1 = Math.round(a.x - 24);
        const y1 = Math.round(Math.max(24, a.y - 48));
        const x2 = Math.round(a.x + 24);
        const y2 = y1;
        edges.push({ sourceKey, targetKey, value: Math.round(asNumber(value, 0) * 100), x1, y1, x2, y2, mx: Math.round(a.x), my: y1 - 12, ...edgeGeometry(x1, y1, x2, y2) });
        continue;
      }
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const trim = 32;
      const x1 = Math.round(a.x + dx / len * trim);
      const y1 = Math.round(a.y + dy / len * trim);
      const x2 = Math.round(b.x - dx / len * trim);
      const y2 = Math.round(b.y - dy / len * trim);
      const mx = Math.round((x1 + x2) / 2);
      const my = Math.round((y1 + y2) / 2);
      edges.push({ sourceKey, targetKey, value: Math.round(asNumber(value, 0) * 100), x1, y1, x2, y2, mx, my, ...edgeGeometry(x1, y1, x2, y2) });
    }
  }
  return edges;
}

export function counterGraphHtml(graphId) {
  const nodes = Object.entries(getMassCombatRelationTags()).map(([key, tag]) => ({ key, ...tag }));
  const width = 560;
  const height = 430;
  const cx = width / 2;
  const cy = 218;
  const radius = 165;
  const positions = graphPositions(nodes, { width, height, cx, cy, radius });
  const edges = graphEdges(nodes, positions);
  const uid = graphId || `fbls-counter-${globalThis.foundry?.utils?.randomID?.(6) ?? Math.floor(Math.random() * 999999)}`;
  const edgeLines = edges.map((edge, index) => {
    const source = safeClass(edge.sourceKey);
    const target = safeClass(edge.targetKey);
    const tone = index % 2 ? "tone-red" : "tone-green";
    return `<div class="counter-edge edge ${tone} from-${source} to-${target}" data-counter-source="${source}" data-counter-target="${target}" data-x1="${edge.x1}" data-y1="${edge.y1}" data-x2="${edge.x2}" data-y2="${edge.y2}" data-mx="${edge.mx}" data-my="${edge.my}" data-l="${edge.edgeLen}" data-a="${edge.angle}" style="--edge-x:${edge.x1}px;--edge-y:${edge.y1}px;--edge-l:${edge.edgeLen}px;--edge-a:${edge.angle}deg;"></div><span class="counter-edge-label edge-label from-${source} to-${target}" data-counter-source="${source}" data-counter-target="${target}" data-mx="${edge.mx}" data-my="${edge.my}" style="left:${edge.mx}px;top:${edge.my}px;">${edge.value}%</span>`;
  }).join("");
  const nodeButtons = nodes.map((node) => {
    const pos = positions.get(node.key);
    return `<button type="button" class="fbls-counter-node node tag-${safeClass(node.key)}" data-counter-tag="${safeClass(node.key)}" data-counter-x="${pos.labelX}" data-counter-y="${pos.labelY}" data-counter-label="${escapeHtml(node.label ?? node.key)}" data-counter-short="${escapeHtml(node.short ?? node.label ?? node.key)}" data-counter-icon="${escapeHtml(node.icon ?? "fa-solid fa-circle")}" style="left:${pos.labelX}px;top:${pos.labelY}px;" title="${escapeHtml(node.hint ?? "")}"><i class="${escapeHtml(node.icon ?? "fa-solid fa-circle")}"></i><span>${escapeHtml(node.short ?? node.label ?? node.key)}</span></button>`;
  }).join("");
  return `
    <div class="fbl-skyhold fbls-dialog-help fbls-skyhold-dark-panel fbls-counter-pentagram" data-counter-graph-id="${uid}" data-selected-tag="all">
      <div class="fbls-help-lead compact"><strong><i class="fa-solid fa-circle-nodes"></i> Матрица контров</strong><span>Клик по типу переносит его в центр. Зеленые стрелки идут от него, красные — к нему.</span></div>
      <div class="fbls-counter-graph-wrap" data-counter-cx="${cx}" data-counter-cy="${cy}" style="--graph-w:${width}px;--graph-h:${height}px;">
        ${edgeLines}
        <button type="button" class="fbls-counter-center" data-counter-clear="true" style="left:${cx}px;top:${cy}px;" title="Убрать выбранный тег из центра"><i class="fa-solid fa-circle-nodes"></i><span>Все</span></button>
        ${nodeButtons}
      </div>
    </div>
  `;
}

function clearGraphClasses(element) {
  element.classList.remove("is-related", "is-outgoing", "is-incoming", "is-selected", "is-source", "is-target", "is-self");
}

function applyGeometry(edge, label, geometry) {
  edge.style.setProperty("--edge-x", `${geometry.x}px`);
  edge.style.setProperty("--edge-y", `${geometry.y}px`);
  edge.style.setProperty("--edge-l", `${geometry.l}px`);
  edge.style.setProperty("--edge-a", `${geometry.a}deg`);
  if (label) {
    label.style.left = `${geometry.mx}px`;
    label.style.top = `${geometry.my}px`;
  }
}

function resetGeometry(edge, label) {
  edge.style.setProperty("--edge-x", `${number(edge.dataset.x1)}px`);
  edge.style.setProperty("--edge-y", `${number(edge.dataset.y1)}px`);
  edge.style.setProperty("--edge-l", `${number(edge.dataset.l, 1)}px`);
  edge.style.setProperty("--edge-a", `${number(edge.dataset.a)}deg`);
  if (label) {
    label.style.left = `${number(label.dataset.mx)}px`;
    label.style.top = `${number(label.dataset.my)}px`;
  }
}

function updateGraph(graph, selected = "all") {
  if (!graph) return;
  graph.dataset.selectedTag = selected;
  const wrap = graph.querySelector(".fbls-counter-graph-wrap");
  const center = graph.querySelector(".fbls-counter-center");
  const cx = number(wrap?.dataset.counterCx, 280);
  const cy = number(wrap?.dataset.counterCy, 218);
  const relatedTags = new Set(selected === "all" ? [] : [selected]);
  graph.querySelectorAll(".counter-edge, .counter-edge-label, .fbls-counter-node").forEach(clearGraphClasses);
  graph.querySelectorAll(".counter-edge").forEach((edge) => resetGeometry(edge, edge.nextElementSibling?.matches?.(".counter-edge-label") ? edge.nextElementSibling : null));
  if (center) {
    center.classList.toggle("is-visible", selected !== "all");
    center.classList.toggle("is-selected", selected !== "all");
  }
  graph.querySelectorAll(".fbls-counter-node").forEach((node) => node.setAttribute("aria-pressed", node.dataset.counterTag === selected ? "true" : "false"));
  const selectedNode = selected === "all" ? null : graph.querySelector(`.fbls-counter-node[data-counter-tag="${selected}"]`);
  if (center && selectedNode) {
    center.innerHTML = `<i class="${selectedNode.dataset.counterIcon || "fa-solid fa-circle"}"></i><span>${selectedNode.dataset.counterShort || selectedNode.dataset.counterLabel || selected}</span>`;
    center.title = `${selectedNode.dataset.counterLabel || selected}: убрать из центра`;
  }
  if (selected === "all" || !selectedNode) return;
  const selectedX = number(selectedNode.dataset.counterX, cx);
  const selectedY = number(selectedNode.dataset.counterY, cy);
  graph.querySelectorAll(".counter-edge").forEach((edge) => {
    const label = edge.nextElementSibling?.matches?.(".counter-edge-label") ? edge.nextElementSibling : null;
    const source = edge.dataset.counterSource;
    const target = edge.dataset.counterTarget;
    const outgoing = source === selected;
    const incoming = target === selected;
    const self = outgoing && incoming;
    edge.classList.toggle("is-related", outgoing || incoming);
    edge.classList.toggle("is-outgoing", outgoing);
    edge.classList.toggle("is-incoming", incoming);
    edge.classList.toggle("is-self", self);
    label?.classList.toggle("is-related", outgoing || incoming);
    label?.classList.toggle("is-outgoing", outgoing);
    label?.classList.toggle("is-incoming", incoming);
    label?.classList.toggle("is-self", self);
    if (self) applyGeometry(edge, label, lineGeometry(selectedX, selectedY, cx, cy, 38, 44));
    else if (outgoing) {
      const targetNode = graph.querySelector(`.fbls-counter-node[data-counter-tag="${target}"]`);
      applyGeometry(edge, label, lineGeometry(cx, cy, number(targetNode?.dataset.counterX, cx), number(targetNode?.dataset.counterY, cy), 44, 38));
    } else if (incoming) {
      const sourceNode = graph.querySelector(`.fbls-counter-node[data-counter-tag="${source}"]`);
      applyGeometry(edge, label, lineGeometry(number(sourceNode?.dataset.counterX, cx), number(sourceNode?.dataset.counterY, cy), cx, cy, 38, 44));
    }
    if (outgoing) relatedTags.add(target);
    if (incoming) relatedTags.add(source);
  });
  graph.querySelectorAll(".fbls-counter-node").forEach((node) => {
    const tag = node.dataset.counterTag;
    node.classList.toggle("is-selected", tag === selected);
    node.classList.toggle("is-related", relatedTags.has(tag));
  });
  graph.querySelectorAll(".counter-edge.is-outgoing").forEach((edge) => {
    graph.querySelector(`.fbls-counter-node[data-counter-tag="${edge.dataset.counterTarget}"]`)?.classList.add("is-target");
  });
  graph.querySelectorAll(".counter-edge.is-incoming").forEach((edge) => {
    graph.querySelector(`.fbls-counter-node[data-counter-tag="${edge.dataset.counterSource}"]`)?.classList.add("is-source");
  });
}

export function bindCounterGraphRuntime(graphId) {
  let disposed = false;
  const graphSelector = `.fbls-counter-pentagram[data-counter-graph-id="${graphId}"]`;
  const onClick = (event) => {
    const button = event.target?.closest?.("[data-counter-tag], [data-counter-clear]");
    if (!button) return;
    const graph = button.closest?.(".fbls-counter-pentagram");
    if (!graph || graph.dataset.counterGraphId !== graphId) return;
    event.preventDefault();
    event.stopPropagation();
    if (button.dataset.counterClear === "true") return updateGraph(graph, "all");
    const tag = button.dataset.counterTag || "all";
    updateGraph(graph, graph.dataset.selectedTag === tag ? "all" : tag);
  };
  const syncInitialState = () => {
    if (!disposed) updateGraph(document.querySelector(graphSelector), "all");
  };
  document.addEventListener("click", onClick, true);
  const initialTimer = setTimeout(syncInitialState, 0);
  return () => {
    disposed = true;
    clearTimeout(initialTimer);
    document.removeEventListener("click", onClick, true);
  };
}
