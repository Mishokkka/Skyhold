const MAX_QD = 1_000_000;

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function whole(value, fallback = 0, maximum = MAX_QD) {
  return Math.min(maximum, Math.max(0, Math.floor(finite(value, fallback))));
}

function text(value = "") {
  return String(value ?? "").trim();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalState(value = {}) {
  const phase = ["empty", "sowing", "growing", "ready", "harvesting"].includes(text(value.phase))
    ? text(value.phase)
    : "empty";
  const readyPhase = phase === "ready" || phase === "harvesting";
  const harvestTotalQty = readyPhase ? whole(value.harvestTotalQty) : 0;
  const harvestedQty = readyPhase ? Math.min(harvestTotalQty, whole(value.harvestedQty)) : 0;
  return {
    version: 1,
    phase,
    cropId: phase === "empty" ? "" : text(value.cropId),
    sowingProgressQd: phase === "sowing" ? whole(value.sowingProgressQd) : 0,
    growingElapsedQd: phase === "growing" ? whole(value.growingElapsedQd) : 0,
    readyAgeQd: readyPhase ? whole(value.readyAgeQd) : 0,
    harvestProgressQd: readyPhase ? whole(value.harvestProgressQd) : 0,
    harvestWorkQdTotal: readyPhase ? Math.max(1, whole(value.harvestWorkQdTotal, 1)) : 0,
    harvestTotalQty,
    harvestedQty,
    readyQty: readyPhase ? Math.max(0, harvestTotalQty - harvestedQty) : 0,
    sowingSeasonKey: phase === "sowing" ? text(value.sowingSeasonKey) : "",
    readySeasonKey: readyPhase ? text(value.readySeasonKey) : "",
    lastSownSeasonKey: text(value.lastSownSeasonKey),
    harvestYear: text(value.harvestYear),
    harvestsThisYear: whole(value.harvestsThisYear),
    establishedCropId: text(value.establishedCropId),
    lastMissedSowingSeasonKey: text(value.lastMissedSowingSeasonKey),
    lastOperationId: text(value.lastOperationId)
  };
}

function canonicalCrop(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const expiryRule = ["never", "qd", "season-end"].includes(text(source.expiryRule)) ? text(source.expiryRule) : "qd";
  return {
    id: text(source.id),
    label: text(source.label || source.id),
    resourceId: text(source.resourceId || source.id),
    outputQty: whole(source.outputQty),
    sowingSeasons: [...new Set((Array.isArray(source.sowingSeasons) ? source.sowingSeasons : [])
      .map((row) => text(row))
      .filter(Boolean))],
    sowingWorkQd: whole(source.sowingWorkQd, 1),
    growingQd: Math.max(1, whole(source.growingQd, 1)),
    harvestWorkQd: Math.max(1, whole(source.harvestWorkQd, 1)),
    expiryRule,
    readyExpiryQd: expiryRule === "qd" ? Math.max(1, whole(source.readyExpiryQd, 1)) : 0,
    annualHarvestLimit: Math.max(1, whole(source.annualHarvestLimit, 1)),
    perennial: source.perennial === true
  };
}

function emptyState(state = {}) {
  return {
    version: 1,
    phase: "empty",
    cropId: "",
    sowingProgressQd: 0,
    growingElapsedQd: 0,
    readyAgeQd: 0,
    harvestProgressQd: 0,
    harvestWorkQdTotal: 0,
    harvestTotalQty: 0,
    harvestedQty: 0,
    readyQty: 0,
    sowingSeasonKey: "",
    readySeasonKey: "",
    lastSownSeasonKey: text(state.lastSownSeasonKey),
    harvestYear: text(state.harvestYear),
    harvestsThisYear: whole(state.harvestsThisYear),
    establishedCropId: text(state.establishedCropId),
    lastMissedSowingSeasonKey: text(state.lastMissedSowingSeasonKey),
    lastOperationId: text(state.lastOperationId)
  };
}

function seasonContext(value = {}) {
  const seasonId = text(value.seasonId ?? value.season?.id ?? value.season?.key);
  const year = text(value.year ?? value.dateTime?.year);
  const seasonKey = text(value.seasonKey) || (year && seasonId ? `${year}:${seasonId}` : "");
  return { seasonId, seasonKey, year: year || (seasonKey.includes(":") ? seasonKey.split(":")[0] : ""), dateKey: text(value.dateKey) };
}

function sowingAllowed(crop, calendar) {
  return Boolean(calendar.seasonKey && crop.sowingSeasons.includes(calendar.seasonId));
}

function readyCropExpired(state, crop, calendar) {
  if (crop.expiryRule === "never") return false;
  if (crop.expiryRule === "season-end") {
    return Boolean(state.readySeasonKey && calendar.seasonKey && state.readySeasonKey !== calendar.seasonKey);
  }
  return state.readyAgeQd >= crop.readyExpiryQd;
}

export function agricultureStateSignature(state = {}) {
  return JSON.stringify(canonicalState(state));
}

export function agricultureConfigurationSignature(value = {}) {
  return JSON.stringify({
    enabled: value.enabled === true,
    kind: text(value.kind),
    activeCropId: text(value.activeCropId),
    outputRoomId: text(value.outputRoomId),
    gmPriority: whole(value.gmPriority),
    operations: {
      sow: value?.operations?.sow === true,
      harvest: value?.operations?.harvest === true
    },
    crop: canonicalCrop(value.crop ?? {})
  });
}

export function planAgriculturePlot({
  state: stateValue = {},
  crop: cropValue = {},
  operations = {},
  elapsedQd = 40,
  availableWorkQd = 0,
  operationId = "",
  calendarContextForOffset = () => ({})
} = {}) {
  if (typeof calendarContextForOffset !== "function") throw new TypeError("FBL Skyhold | Agriculture requires calendarContextForOffset.");
  const stateBefore = canonicalState(stateValue);
  const crop = canonicalCrop(cropValue);
  const opId = text(operationId);
  const periodQd = whole(elapsedQd);
  const workAvailable = whole(availableWorkQd);
  if (!crop.id || !crop.resourceId) {
    return {
      version: 1,
      operationId: opId,
      replay: false,
      elapsedQd: periodQd,
      workQdAvailable: workAvailable,
      workQdUsed: 0,
      crop,
      stateBefore,
      stateAfter: clone(stateBefore),
      resourceChanges: [],
      events: [],
      warnings: ["Не выбрана корректная культура."]
    };
  }
  if (opId && stateBefore.lastOperationId === opId) {
    return {
      version: 1,
      operationId: opId,
      replay: true,
      elapsedQd: periodQd,
      workQdAvailable: workAvailable,
      workQdUsed: 0,
      crop,
      stateBefore,
      stateAfter: clone(stateBefore),
      resourceChanges: [],
      events: [],
      warnings: []
    };
  }

  let state = clone(stateBefore);
  let workRemaining = workAvailable;
  let producedQty = 0;
  const events = [];
  const warnings = [];

  if (state.phase !== "empty" && state.cropId !== crop.id) {
    events.push({ kind: "crop-reset", offsetQd: 0, previousCropId: state.cropId, cropId: crop.id });
    warnings.push("Выбранная культура изменилась: незавершённый цикл участка сброшен.");
    state = emptyState(state);
  }

  for (let offsetQd = 0; offsetQd < periodQd; offsetQd += 1) {
    const calendar = seasonContext(calendarContextForOffset(offsetQd) ?? {});
    if (calendar.year && state.harvestYear !== calendar.year) {
      state.harvestYear = calendar.year;
      state.harvestsThisYear = 0;
    }
    const established = crop.perennial && state.establishedCropId === crop.id;
    const sowingWorkQd = established ? 0 : crop.sowingWorkQd;

    if (state.phase === "sowing" && (
      !sowingAllowed(crop, calendar)
      || (state.sowingSeasonKey && calendar.seasonKey !== state.sowingSeasonKey)
    )) {
      const missedSeasonKey = state.sowingSeasonKey || state.lastSownSeasonKey;
      events.push({ kind: "missed-sowing", offsetQd, cropId: crop.id, seasonKey: missedSeasonKey });
      warnings.push(`Посев «${crop.label || crop.id}» не завершён в допустимый сезон; урожая этого цикла не будет.`);
      state.lastMissedSowingSeasonKey = missedSeasonKey;
      state = emptyState(state);
    }

    if (
      state.phase === "empty"
      && operations.sow === true
      && (workRemaining > 0 || sowingWorkQd === 0)
      && (!calendar.year || state.harvestsThisYear < crop.annualHarvestLimit)
      && sowingAllowed(crop, calendar)
      && state.lastSownSeasonKey !== calendar.seasonKey
    ) {
      state.phase = "sowing";
      state.cropId = crop.id;
      state.sowingSeasonKey = calendar.seasonKey;
      state.lastSownSeasonKey = calendar.seasonKey;
      events.push({ kind: "sowing-started", offsetQd, cropId: crop.id, seasonKey: calendar.seasonKey });
    }

    if (state.phase === "sowing") {
      const required = Math.max(0, sowingWorkQd - state.sowingProgressQd);
      const spent = Math.min(required, workRemaining);
      state.sowingProgressQd += spent;
      workRemaining -= spent;
      if (spent > 0) events.push({ kind: "sowing-work", offsetQd, cropId: crop.id, workQd: spent });
      if (state.sowingProgressQd >= sowingWorkQd) {
        state.establishedCropId = crop.perennial ? crop.id : "";
        state.phase = "growing";
        state.sowingProgressQd = 0;
        state.sowingSeasonKey = "";
        state.growingElapsedQd = 0;
        events.push({ kind: "sown", offsetQd, cropId: crop.id, seasonKey: calendar.seasonKey });
      }
    }

    if (state.phase === "growing") {
      state.growingElapsedQd += 1;
      if (state.growingElapsedQd >= crop.growingQd) {
        state.phase = "ready";
        state.harvestsThisYear += 1;
        state.growingElapsedQd = 0;
        state.readyAgeQd = 0;
        state.harvestProgressQd = 0;
        state.harvestWorkQdTotal = crop.harvestWorkQd;
        state.harvestTotalQty = crop.outputQty;
        state.harvestedQty = 0;
        state.readyQty = crop.outputQty;
        state.readySeasonKey = calendar.seasonKey;
        events.push({ kind: "ready", offsetQd, cropId: crop.id, qty: crop.outputQty, seasonKey: calendar.seasonKey });
      }
    }

    if (state.phase === "ready" || state.phase === "harvesting") {
      if (readyCropExpired(state, crop, calendar)) {
        const lostQty = state.readyQty;
        events.push({ kind: "expired", offsetQd, cropId: crop.id, qty: lostQty, seasonKey: calendar.seasonKey });
        if (lostQty > 0) warnings.push(`Несобранный урожай «${crop.label || crop.id}» погиб: ${lostQty} ед.`);
        state = emptyState(state);
        continue;
      }

      if (operations.harvest === true && workRemaining > 0) {
        const required = Math.max(0, state.harvestWorkQdTotal - state.harvestProgressQd);
        const spent = Math.min(required, workRemaining);
        state.harvestProgressQd += spent;
        workRemaining -= spent;
        state.phase = state.harvestProgressQd > 0 ? "harvesting" : "ready";
        const cumulativeHarvested = state.harvestProgressQd >= state.harvestWorkQdTotal
          ? state.harvestTotalQty
          : Math.floor((state.harvestTotalQty * state.harvestProgressQd) / state.harvestWorkQdTotal);
        const transferred = Math.max(0, cumulativeHarvested - state.harvestedQty);
        state.harvestedQty += transferred;
        state.readyQty = Math.max(0, state.harvestTotalQty - state.harvestedQty);
        producedQty += transferred;
        if (spent > 0 || transferred > 0) events.push({ kind: "harvest-work", offsetQd, cropId: crop.id, workQd: spent, qty: transferred });
        if (state.harvestProgressQd >= state.harvestWorkQdTotal) {
          events.push({ kind: "harvested", offsetQd, cropId: crop.id, qty: state.harvestTotalQty });
          state = emptyState(state);
          continue;
        }
      }

      state.readyAgeQd += 1;
      if (readyCropExpired(state, crop, calendar)) {
        const lostQty = state.readyQty;
        events.push({ kind: "expired", offsetQd: offsetQd + 1, cropId: crop.id, qty: lostQty, seasonKey: calendar.seasonKey });
        if (lostQty > 0) warnings.push(`Несобранный урожай «${crop.label || crop.id}» погиб: ${lostQty} ед.`);
        state = emptyState(state);
      }
    }
  }

  if (opId) state.lastOperationId = opId;
  const workQdUsed = workAvailable - workRemaining;
  return {
    version: 1,
    operationId: opId,
    replay: false,
    elapsedQd: periodQd,
    workQdAvailable: workAvailable,
    workQdUsed,
    crop,
    stateBefore,
    stateAfter: canonicalState(state),
    resourceChanges: producedQty > 0 ? [{ resourceId: crop.resourceId, qty: whole(producedQty) }] : [],
    events,
    warnings: [...new Set(warnings)]
  };
}
