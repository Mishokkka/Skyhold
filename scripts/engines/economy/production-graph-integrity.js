import { materialGroup, resourceMatchesMaterialGroup } from "../../core/material-groups.js";

const EPSILON = 1e-9;
const MAX_GROUP_VARIANTS = 4096;
const KNOWN_CADENCES = new Set(["qd", "day", "tenday", "season", "year"]);

function finitePositive(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizedKey(value = "") {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
}

function fallbackResourceId(value = "") {
  return normalizedKey(value)
    .replace(/[^a-z0-9а-я]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "custom";
}

function resourceIndex(resources = []) {
  const byId = new Map();
  const byAlias = new Map();
  for (const raw of Array.isArray(resources) ? resources : []) {
    const id = String(raw?.id ?? raw?.resourceId ?? "").trim();
    if (!id || byId.has(id)) continue;
    const resource = { ...raw, id, resourceId: id };
    byId.set(id, resource);
    const aliases = [id, raw?.label, raw?.name, ...(Array.isArray(raw?.aliases) ? raw.aliases : [])];
    for (const alias of aliases) {
      const key = normalizedKey(alias);
      if (key && !byAlias.has(key)) byAlias.set(key, id);
    }
  }
  return { byId, byAlias };
}

function resolveResourceId(value, index) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("group:")) return raw;
  if (index.byId.has(raw)) return raw;
  return index.byAlias.get(normalizedKey(raw)) ?? fallbackResourceId(raw);
}

function parseCostPart(part, index) {
  const tail = part.match(/^(.*?)([-+]?\d+(?:[.,]\d+)?)\s*$/);
  const head = part.match(/^([-+]?\d+(?:[.,]\d+)?)\s+(.+)$/);
  let name = part;
  let qty = 1;
  if (tail && tail[1].trim()) {
    name = tail[1].trim();
    qty = Number(String(tail[2]).replace(",", "."));
  } else if (head) {
    qty = Number(String(head[1]).replace(",", "."));
    name = head[2].trim();
  }
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const group = materialGroup(name);
  if (group) return { kind: "group", groupId: group.id, resourceId: `group:${group.id}`, qty };
  const resourceId = resolveResourceId(name, index);
  return resourceId ? { kind: "resource", resourceId, qty } : null;
}

function structuredInput(raw, index) {
  const qty = finitePositive(raw?.qty ?? raw?.quantity ?? raw?.amount, 0);
  if (!qty) return null;
  const rawGroup = String(raw?.resourceGroup ?? raw?.groupId ?? raw?.resourceId ?? "").trim();
  const group = materialGroup(rawGroup.startsWith("group:") ? rawGroup.slice("group:".length) : rawGroup);
  if (group) return { kind: "group", groupId: group.id, resourceId: `group:${group.id}`, qty };
  const resourceId = resolveResourceId(raw?.resourceId ?? raw?.id ?? raw?.name ?? raw?.label, index);
  return resourceId ? { kind: "resource", resourceId, qty } : null;
}

function lineInputs(line, index, outputQty) {
  const structured = Array.isArray(line?.inputs)
    ? line.inputs
    : (Array.isArray(line?.costs) ? line.costs : null);
  const inputs = structured
    ? structured.map((raw) => structuredInput(raw, index)).filter(Boolean)
    : String(line?.expenses ?? line?.costsText ?? "")
      .split(/[;,\n]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => parseCostPart(part, index))
      .filter(Boolean);
  const multiplier = String(line?.expenseMode ?? "cycle").trim().toLowerCase() === "unit"
    ? outputQty
    : 1;
  return inputs.map((input) => ({ ...input, qty: input.qty * multiplier }));
}

function structuredOutput(raw, index) {
  const resourceId = resolveResourceId(raw?.resourceId ?? raw?.id ?? raw?.name ?? raw?.label, index);
  const qty = finitePositive(raw?.qty ?? raw?.quantity ?? raw?.outputQty ?? raw?.amount, 0);
  return resourceId && qty ? { resourceId, qty } : null;
}

function lineOutputs(line, index) {
  const structured = Array.isArray(line?.outputs) ? line.outputs : null;
  if (structured?.length) return structured.map((raw) => structuredOutput(raw, index)).filter(Boolean);
  const resourceId = resolveResourceId(line?.resourceId ?? line?.resource ?? line?.name, index);
  const qty = finitePositive(line?.outputQty ?? line?.output ?? line?.quantity ?? line?.base, 0);
  return resourceId && qty ? [{ resourceId, qty }] : [];
}

function contentState(building, line) {
  const contentId = String(line?.contentId ?? line?.contentKey ?? "").trim();
  if (!contentId) return { canProduce: false, reason: null };
  const contents = Array.isArray(building?.contents) ? building.contents : [];
  const row = contents.find((item, index) => String(item?.id ?? `content-${index}`) === contentId);
  if (!row) return { canProduce: false, reason: null };
  const quantity = Math.max(0, Number(row?.qty ?? row?.quantity ?? row?.count ?? 0) || 0);
  const capacity = Math.max(0, Number(row?.capacity ?? row?.maxQty ?? quantity) || 0);
  return {
    canProduce: quantity > 0 || capacity > 0,
    reason: { kind: "finite-content", contentId, quantity, capacity }
  };
}

/**
 * Describes the non-resource limits which keep one production line bounded.
 * The function is pure and deliberately uses explicit persisted fields rather
 * than the runtime normalizer's fallbacks, so malformed content is visible.
 */
export function productionLineLimiters(building = {}, line = {}) {
  const reasons = [];
  const source = String(line?.source ?? "").trim().toLowerCase();
  let canProduce = line?.active !== false;

  if (source === "workers") {
    const laborQd = finitePositive(line?.laborQdPerBatch ?? line?.workQd, 0);
    if (laborQd) reasons.push({ kind: "labor", laborQd });
  } else if (source === "time") {
    reasons.push({ kind: "passive-source", source: "time" });
  } else if (source === "content") {
    const state = contentState(building, line);
    canProduce = canProduce && state.canProduce;
    if (state.reason) reasons.push(state.reason);
  }

  const cadence = String(line?.cadence ?? "").trim().toLowerCase();
  const cadenceEvery = finitePositive(line?.cadenceEvery, 0);
  const maxBatches = finitePositive(line?.maxBatchesPerCadence, 0);
  if (maxBatches) reasons.push({ kind: "cadence-cap", cadence: KNOWN_CADENCES.has(cadence) ? cadence : "", cadenceEvery, maxBatches });

  if (line?.requiresCollection === true) {
    const collectQd = finitePositive(line?.collectQd ?? line?.collectionQd, 0);
    const autoCollect = String(line?.autoCollect ?? line?.collectionMode ?? "none").trim().toLowerCase();
    if (collectQd) reasons.push({ kind: "collection-labor", collectQd });
    else if (autoCollect === "none") reasons.push({ kind: "manual-collection" });
  }

  return { source, canProduce, limited: reasons.length > 0, reasons };
}

function buildReactions(buildings, resources) {
  const index = resourceIndex(resources);
  const reactions = [];
  for (const [buildingIndex, building] of (Array.isArray(buildings) ? buildings : []).entries()) {
    const buildingId = String(building?.id ?? `building-${buildingIndex}`);
    const lines = Array.isArray(building?.productionLines) ? building.productionLines : [];
    for (const [lineIndex, line] of lines.entries()) {
      const lineId = String(line?.id ?? `line-${lineIndex}`);
      const outputs = lineOutputs(line, index);
      const outputQty = outputs.reduce((sum, output) => sum + output.qty, 0);
      const limits = productionLineLimiters(building, line);
      if (!limits.canProduce || !outputs.length) continue;
      reactions.push({
        key: `${buildingId}/${lineId}#${buildingIndex}:${lineIndex}`,
        buildingId,
        lineId,
        buildingName: String(building?.name ?? buildingId),
        lineName: String(line?.name ?? line?.mode ?? lineId),
        inputs: lineInputs(line, index, outputQty),
        outputs,
        limits
      });
    }
  }
  return { reactions, index };
}

function outputIds(reactions) {
  return new Set(reactions.flatMap((reaction) => reaction.outputs.map((output) => output.resourceId)));
}

function groupMatchesOutput(groupId, resourceId, index) {
  const resource = index.byId.get(resourceId) ?? { id: resourceId, resourceId };
  return resourceMatchesMaterialGroup(resource, groupId, resource);
}

function inputMatchesOutput(input, resourceId, index) {
  return input.kind === "group"
    ? groupMatchesOutput(input.groupId, resourceId, index)
    : input.resourceId === resourceId;
}

function producersForInput(input, reactions, index) {
  const producers = [];
  for (let reactionIndex = 0; reactionIndex < reactions.length; reactionIndex += 1) {
    if (reactions[reactionIndex].outputs.some((output) => inputMatchesOutput(input, output.resourceId, index))) {
      producers.push(reactionIndex);
    }
  }
  return producers;
}

function adjacencyFor(reactions, index) {
  const adjacency = reactions.map(() => new Set());
  for (let consumerIndex = 0; consumerIndex < reactions.length; consumerIndex += 1) {
    for (const input of reactions[consumerIndex].inputs) {
      for (const producerIndex of producersForInput(input, reactions, index)) adjacency[producerIndex].add(consumerIndex);
    }
  }
  return adjacency;
}

function stronglyConnectedComponents(adjacency) {
  const components = [];
  const stack = [];
  const onStack = new Set();
  const indices = new Array(adjacency.length).fill(-1);
  const lowLinks = new Array(adjacency.length).fill(-1);
  let nextIndex = 0;

  const visit = (node) => {
    indices[node] = nextIndex;
    lowLinks[node] = nextIndex;
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of adjacency[node]) {
      if (indices[target] < 0) {
        visit(target);
        lowLinks[node] = Math.min(lowLinks[node], lowLinks[target]);
      } else if (onStack.has(target)) {
        lowLinks[node] = Math.min(lowLinks[node], indices[target]);
      }
    }

    if (lowLinks[node] !== indices[node]) return;
    const component = [];
    while (stack.length) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort((left, right) => left - right));
  };

  for (let node = 0; node < adjacency.length; node += 1) if (indices[node] < 0) visit(node);
  return components;
}

function componentHasCycle(component, adjacency) {
  if (component.length > 1) return true;
  return component.length === 1 && adjacency[component[0]].has(component[0]);
}

function componentIsClosed(component, reactions, index) {
  const members = component.map((reactionIndex) => reactions[reactionIndex]);
  const outputs = outputIds(members);
  return members.every((reaction) => reaction.inputs.every((input) => {
    if (input.kind === "group") return [...outputs].some((resourceId) => groupMatchesOutput(input.groupId, resourceId, index));
    return outputs.has(input.resourceId);
  }));
}

function groupCandidates(input, componentReactions, index) {
  return [...outputIds(componentReactions)]
    .filter((resourceId) => groupMatchesOutput(input.groupId, resourceId, index))
    .sort((left, right) => left.localeCompare(right));
}

function expandReactionVariants(reaction, componentReactions, index) {
  let variants = [{ inputs: [], selections: [] }];
  for (const input of reaction.inputs) {
    const candidates = input.kind === "group"
      ? groupCandidates(input, componentReactions, index)
      : [input.resourceId];
    const next = [];
    for (const variant of variants) {
      for (const resourceId of candidates) {
        next.push({
          inputs: [...variant.inputs, { resourceId, qty: input.qty }],
          selections: input.kind === "group"
            ? [...variant.selections, { groupId: input.groupId, resourceId }]
            : variant.selections
        });
        if (next.length > MAX_GROUP_VARIANTS) return { variants: [], complete: false };
      }
    }
    variants = next;
  }
  return {
    complete: true,
    variants: variants.map((variant, variantIndex) => ({
      ...reaction,
      variantIndex,
      resolvedInputs: variant.inputs,
      groupSelections: variant.selections
    }))
  };
}

function pivot(tableau, pivotRow, pivotColumn) {
  const divisor = tableau[pivotRow][pivotColumn];
  for (let column = 0; column < tableau[pivotRow].length; column += 1) tableau[pivotRow][column] /= divisor;
  for (let row = 0; row < tableau.length; row += 1) {
    if (row === pivotRow) continue;
    const multiplier = tableau[row][pivotColumn];
    if (Math.abs(multiplier) <= EPSILON) continue;
    for (let column = 0; column < tableau[row].length; column += 1) {
      tableau[row][column] -= multiplier * tableau[pivotRow][column];
    }
  }
}

// Maximizes c*x under A*x <= b and x >= 0. All callers use b >= 0, so the
// slack basis is a feasible starting point and no phase-one solver is needed.
function simplexMaximize(A, b, c) {
  const constraintCount = A.length;
  const variableCount = c.length;
  const rhsColumn = variableCount + constraintCount;
  const tableau = Array.from({ length: constraintCount + 1 }, () => new Array(rhsColumn + 1).fill(0));
  const basis = new Array(constraintCount);
  for (let row = 0; row < constraintCount; row += 1) {
    for (let column = 0; column < variableCount; column += 1) tableau[row][column] = A[row][column];
    tableau[row][variableCount + row] = 1;
    tableau[row][rhsColumn] = b[row];
    basis[row] = variableCount + row;
  }
  for (let column = 0; column < variableCount; column += 1) tableau[constraintCount][column] = -c[column];

  const maxIterations = Math.max(100, (variableCount + constraintCount) * 40);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let entering = -1;
    for (let column = 0; column < rhsColumn; column += 1) {
      if (tableau[constraintCount][column] < -EPSILON) {
        entering = column;
        break;
      }
    }
    if (entering < 0) break;

    let leaving = -1;
    let bestRatio = Infinity;
    for (let row = 0; row < constraintCount; row += 1) {
      const coefficient = tableau[row][entering];
      if (coefficient <= EPSILON) continue;
      const ratio = tableau[row][rhsColumn] / coefficient;
      if (ratio < bestRatio - EPSILON || (Math.abs(ratio - bestRatio) <= EPSILON && (leaving < 0 || basis[row] < basis[leaving]))) {
        leaving = row;
        bestRatio = ratio;
      }
    }
    if (leaving < 0) return { complete: false, value: Infinity, solution: [] };
    pivot(tableau, leaving, entering);
    basis[leaving] = entering;
    if (iteration === maxIterations - 1) return { complete: false, value: NaN, solution: [] };
  }

  const solution = new Array(variableCount).fill(0);
  for (let row = 0; row < constraintCount; row += 1) {
    if (basis[row] < variableCount) solution[basis[row]] = Math.max(0, tableau[row][rhsColumn]);
  }
  return { complete: true, value: Math.max(0, tableau[constraintCount][rhsColumn]), solution };
}

function positiveCycleWitness(componentReactions, index) {
  const variants = [];
  for (const reaction of componentReactions) {
    const expanded = expandReactionVariants(reaction, componentReactions, index);
    if (!expanded.complete) return { complete: false, reason: "group-variant-limit" };
    variants.push(...expanded.variants);
  }
  const resourceIds = [...new Set(variants.flatMap((reaction) => [
    ...reaction.outputs.map((output) => output.resourceId),
    ...reaction.resolvedInputs.map((input) => input.resourceId)
  ]))].sort((left, right) => left.localeCompare(right));
  const resourcePosition = new Map(resourceIds.map((resourceId, position) => [resourceId, position]));
  const stoichiometry = resourceIds.map(() => new Array(variants.length).fill(0));
  for (let column = 0; column < variants.length; column += 1) {
    for (const output of variants[column].outputs) stoichiometry[resourcePosition.get(output.resourceId)][column] += output.qty;
    for (const input of variants[column].resolvedInputs) stoichiometry[resourcePosition.get(input.resourceId)][column] -= input.qty;
  }

  const objective = variants.map((_, column) => stoichiometry.reduce((sum, row) => sum + row[column], 0));
  const constraints = stoichiometry.map((row) => row.map((coefficient) => -coefficient));
  constraints.push(new Array(variants.length).fill(1));
  const bounds = new Array(resourceIds.length).fill(0);
  bounds.push(1);
  const solved = simplexMaximize(constraints, bounds, objective);
  if (!solved.complete) return { complete: false, reason: "linear-solver-limit" };
  if (!(solved.value > EPSILON)) return { complete: true, profitable: false };

  const net = new Array(resourceIds.length).fill(0);
  for (let row = 0; row < resourceIds.length; row += 1) {
    for (let column = 0; column < variants.length; column += 1) net[row] += stoichiometry[row][column] * solved.solution[column];
  }
  if (net.some((quantity) => quantity < -EPSILON) || !net.some((quantity) => quantity > EPSILON)) {
    return { complete: false, reason: "invalid-linear-witness" };
  }

  const positiveFirings = solved.solution.filter((quantity) => quantity > EPSILON);
  const scale = positiveFirings.length ? 1 / Math.min(...positiveFirings) : 1;
  const rounded = (value) => Math.round(value * 1e6) / 1e6;
  return {
    complete: true,
    profitable: true,
    firings: variants
      .map((reaction, column) => ({ reaction, quantity: solved.solution[column] }))
      .filter((entry) => entry.quantity > EPSILON)
      .map((entry) => ({
        buildingId: entry.reaction.buildingId,
        lineId: entry.reaction.lineId,
        quantity: rounded(entry.quantity * scale),
        groupSelections: entry.reaction.groupSelections
      })),
    netOutputs: Object.fromEntries(resourceIds
      .map((resourceId, row) => [resourceId, rounded(net[row] * scale)])
      .filter(([, quantity]) => quantity > EPSILON))
  };
}

function actionableLines(reactions) {
  return reactions
    .map((reaction) => ({ buildingId: reaction.buildingId, lineId: reaction.lineId }))
    .sort((left, right) => `${left.buildingId}/${left.lineId}`.localeCompare(`${right.buildingId}/${right.lineId}`));
}

/**
 * Finds declarative production recipes which can increase stock without an
 * outside input or a rate limiter. The analyzer never mutates catalog rows.
 */
export function analyzeProductionGraphIntegrity({ buildings = [], resources = [] } = {}) {
  const { reactions, index } = buildReactions(buildings, resources);
  const unconstrained = reactions.filter((reaction) => !reaction.limits.limited);
  const issues = [];
  const diagnostics = [];

  for (const reaction of unconstrained.filter((candidate) => candidate.inputs.length === 0)) {
    issues.push({
      code: "unbounded-production-source",
      severity: "error",
      message: `Production line ${reaction.buildingId}/${reaction.lineId} creates stock without an input or limiter.`,
      buildingIds: [reaction.buildingId],
      lineIds: [reaction.lineId],
      lines: actionableLines([reaction]),
      netOutputs: Object.fromEntries(reaction.outputs.map((output) => [output.resourceId, output.qty])),
      action: "Add worker QD, a passive/cadence cap, collection work, finite content, or a consumed resource."
    });
  }

  const cyclicCandidates = unconstrained.filter((reaction) => reaction.inputs.length > 0);
  const adjacency = adjacencyFor(cyclicCandidates, index);
  const components = stronglyConnectedComponents(adjacency);
  for (const component of components) {
    if (!componentHasCycle(component, adjacency)) continue;
    if (!componentIsClosed(component, cyclicCandidates, index)) continue;
    const componentReactions = component.map((reactionIndex) => cyclicCandidates[reactionIndex]);
    const witness = positiveCycleWitness(componentReactions, index);
    if (!witness.complete) {
      diagnostics.push({
        code: "production-cycle-analysis-incomplete",
        reason: witness.reason,
        lines: actionableLines(componentReactions)
      });
      continue;
    }
    if (!witness.profitable) continue;
    const lines = actionableLines(componentReactions);
    const refs = lines.map((line) => `${line.buildingId}/${line.lineId}`).join(", ");
    issues.push({
      code: "unbounded-positive-production-cycle",
      severity: "error",
      message: `Production cycle ${refs} can create net stock without an outside input or limiter.`,
      buildingIds: [...new Set(lines.map((line) => line.buildingId))],
      lineIds: lines.map((line) => line.lineId),
      lines,
      witness: witness.firings,
      netOutputs: witness.netOutputs,
      action: "Add an external input, worker QD, collection work, a passive/cadence cap, or finite content to at least one line."
    });
  }

  return {
    ok: issues.length === 0 && diagnostics.length === 0,
    issues,
    diagnostics,
    analyzedLineCount: reactions.length,
    unconstrainedLineCount: unconstrained.length
  };
}
