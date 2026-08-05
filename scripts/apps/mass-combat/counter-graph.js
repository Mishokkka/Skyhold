import { createSafeIcon, escapeAttribute, escapeHtml, safeIconClasses } from "../../core/helpers.js";
import { makeId } from "../../data/utils.js";
import { getMassCombatRelationTags, getMassCombatTagCounters } from "./tag-config.js";
import { asNumber } from "./rules.js";

function safeClass(value) {
  return String(value ?? "").replace(/[^a-z0-9_-]/gi, "-");
}

function safeIconClassString(value) {
  return safeIconClasses(value, ["fa-solid", "fa-circle"]).join(" ");
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
  const startAngle = (-Math.PI / 2) + (Math.PI / Math.max(1, nodes.length));
  return new Map(nodes.map((node, index) => {
    const angle = startAngle + (Math.PI * 2 * index / nodes.length);
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
  const radius = Math.max(245, Math.ceil(nodes.length * 116 / (Math.PI * 2)));
  const width = radius * 2 + 260;
  const height = radius * 2 + 180;
  const cx = width / 2;
  const cy = height / 2;
  const positions = graphPositions(nodes, { width, height, cx, cy, radius });
  const edges = graphEdges(nodes, positions);
  const uid = graphId || makeId("fbls-counter", 6);
  const edgeLines = edges.map((edge) => {
    const source = safeClass(edge.sourceKey);
    const target = safeClass(edge.targetKey);
    const strength = edge.value >= 75 ? "full" : edge.value >= 50 ? "strong" : "base";
    return `<div class="counter-edge edge strength-${strength} from-${source} to-${target}" data-counter-source="${source}" data-counter-target="${target}" data-x1="${edge.x1}" data-y1="${edge.y1}" data-x2="${edge.x2}" data-y2="${edge.y2}" data-mx="${edge.mx}" data-my="${edge.my}" data-l="${edge.edgeLen}" data-a="${edge.angle}" style="--edge-x:${edge.x1}px;--edge-y:${edge.y1}px;--edge-l:${edge.edgeLen}px;--edge-a:${edge.angle}deg;"></div><span class="counter-edge-label edge-label from-${source} to-${target}" data-counter-source="${source}" data-counter-target="${target}" data-mx="${edge.mx}" data-my="${edge.my}" style="left:${edge.mx}px;top:${edge.my}px;">${edge.value}%</span>`;
  }).join("");
  const nodeButtons = nodes.map((node) => {
    const pos = positions.get(node.key);
    const iconClass = safeIconClassString(node.icon);
    return `<div class="fbls-counter-node node tag-${safeClass(node.key)}" role="button" tabindex="0" aria-pressed="false" data-counter-tag="${safeClass(node.key)}" data-counter-x="${pos.labelX}" data-counter-y="${pos.labelY}" data-counter-label="${escapeAttribute(node.label ?? node.key)}" data-counter-short="${escapeAttribute(node.short ?? node.label ?? node.key)}" data-counter-icon="${escapeAttribute(iconClass)}" style="left:${pos.labelX}px;top:${pos.labelY}px;" title="${escapeAttribute(node.hint ?? "")}"><i class="${escapeAttribute(iconClass)}"></i><span>${escapeHtml(node.label ?? node.key)}</span></div>`;
  }).join("");
  return `
    <div class="fbls-counter-pentagram" data-counter-graph-id="${uid}" data-selected-tag="all">
      <div class="fbls-counter-graph-wrap" data-counter-cx="${cx}" data-counter-cy="${cy}" style="--graph-w:${width}px;--graph-h:${height}px;">
        ${edgeLines}
        <div class="fbls-counter-center" role="button" tabindex="0" data-counter-clear="true" style="left:${cx}px;top:${cy}px;" title="Убрать выбранный тег из центра"><i class="fa-solid fa-circle-nodes"></i><span>Все</span></div>
        ${nodeButtons}
      </div>
    </div>
  `;
}

function clearGraphClasses(element) {
  element.classList.remove("is-related", "is-outgoing", "is-incoming", "is-selected", "is-source", "is-target", "is-self", "is-filtered-out");
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
    const label = selectedNode.dataset.counterShort || selectedNode.dataset.counterLabel || selected;
    const text = document.createElement("span");
    text.textContent = label;
    center.replaceChildren(createSafeIcon(selectedNode.dataset.counterIcon || "fa-solid fa-circle"), text);
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
    const related = outgoing || incoming;
    edge.classList.toggle("is-filtered-out", !related);
    edge.classList.toggle("is-related", related);
    edge.classList.toggle("is-outgoing", outgoing);
    edge.classList.toggle("is-incoming", incoming);
    edge.classList.toggle("is-self", self);
    label?.classList.toggle("is-filtered-out", !related);
    label?.classList.toggle("is-related", related);
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

export function bindCounterGraphRuntime(graphId, root = document) {
  const graph = root?.querySelector?.(`.fbls-counter-pentagram[data-counter-graph-id="${graphId}"]`);
  if (!graph) return () => {};
  const activate = (event, control) => {
    if (!control || !graph.contains(control)) return;
    event.preventDefault();
    event.stopPropagation();
    if (control.dataset.counterClear === "true") return updateGraph(graph, "all");
    const tag = control.dataset.counterTag || "all";
    updateGraph(graph, graph.dataset.selectedTag === tag ? "all" : tag);
  };
  const onClick = (event) => activate(event, event.target?.closest?.("[data-counter-tag], [data-counter-clear]"));
  const onKeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    activate(event, event.target?.closest?.("[data-counter-tag], [data-counter-clear]"));
  };
  graph.addEventListener("click", onClick);
  graph.addEventListener("keydown", onKeydown);
  updateGraph(graph, "all");
  return () => {
    graph.removeEventListener("click", onClick);
    graph.removeEventListener("keydown", onKeydown);
  };
}
