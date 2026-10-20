import {
  AGRICULTURE_PHASES,
  normalizeAgricultureBuilding
} from "../../../data/agriculture.js";

const SEASON_LABELS = Object.freeze({
  spring: "Зарость I",
  summer: "Зарость II",
  autumn: "Ухудно I",
  winter: "Ухудно II"
});

const SEASON_SHORTS = Object.freeze({ spring: "ЗI", summer: "ЗII", autumn: "УI", winter: "УII" });

const PHASE_LABELS = Object.freeze({
  empty: "Пусто",
  sowing: "Посев",
  growing: "Рост",
  ready: "Готово",
  harvesting: "Сбор"
});

const KIND_LABELS = Object.freeze({
  field: "Полевое хозяйство",
  garden: "Сад",
  vineyard: "Виноградник",
  "hop-yard": "Хмельник",
  apiary: "Пасека"
});

function text(value = "") {
  return String(value ?? "").trim();
}

function expiryLabel(crop = {}) {
  if (crop.expiryRule === "never") return "не погибает автоматически";
  if (crop.expiryRule === "season-end") return "погибает при смене сезона";
  return `погибает через ${crop.readyExpiryQd} QD`;
}

export const BuildingAgricultureDomain = {
_prepareAgricultureBuildingView(holding, building, basePath = "", storageRooms = []) {
  const agriculture = normalizeAgricultureBuilding(building?.agriculture, { building });
  if (!agriculture) return null;
  const activeCrop = agriculture.crops.find((crop) => crop.id === agriculture.activeCropId) ?? null;
  const state = agriculture.state;
  const outputRoomId = this._normalizeStorageRoomId?.(agriculture.outputRoomId) ?? text(agriculture.outputRoomId || "outdoors");
  const outputRoomOptions = this._storageRoomOptionsFromRooms?.(storageRooms, outputRoomId)
    ?? this._storageRoomOptions?.(holding, outputRoomId)
    ?? [{ value: "outdoors", label: "Под открытым небом", selected: true }];
  if (!outputRoomOptions.some((row) => row.value === "auto")) outputRoomOptions.unshift({ value: "auto", label: "Предпочтительные склады", selected: outputRoomId === "auto" });
  const cropRows = agriculture.crops.map((crop, index) => ({
    ...crop,
    index,
    number: index + 1,
    active: crop.id === agriculture.activeCropId,
    expiryLabel: expiryLabel(crop),
    usesQdExpiry: crop.expiryRule === "qd",
    labelPath: `${basePath}.agriculture.crops.${index}.label`,
    resourceIdPath: `${basePath}.agriculture.crops.${index}.resourceId`,
    outputQtyPath: `${basePath}.agriculture.crops.${index}.outputQty`,
    sowingWorkQdPath: `${basePath}.agriculture.crops.${index}.sowingWorkQd`,
    growingQdPath: `${basePath}.agriculture.crops.${index}.growingQd`,
    harvestWorkQdPath: `${basePath}.agriculture.crops.${index}.harvestWorkQd`,
    expiryRulePath: `${basePath}.agriculture.crops.${index}.expiryRule`,
    readyExpiryQdPath: `${basePath}.agriculture.crops.${index}.readyExpiryQd`,
    expiryOptions: [
      { value: "never", label: "Не погибает", selected: crop.expiryRule === "never" },
      { value: "qd", label: "Через QD", selected: crop.expiryRule === "qd" },
      { value: "season-end", label: "При смене сезона", selected: crop.expiryRule === "season-end" }
    ],
    seasonOptions: Object.entries(SEASON_LABELS).map(([seasonId, label]) => ({
      seasonId,
      label,
      short: SEASON_SHORTS[seasonId],
      selected: crop.sowingSeasons.includes(seasonId)
    }))
  }));

  return {
    enabled: agriculture.enabled,
    kind: agriculture.kind,
    kindLabel: KIND_LABELS[agriculture.kind] ?? agriculture.kind,
    activeCrop,
    hasActiveCrop: Boolean(activeCrop),
    activeCropId: agriculture.activeCropId,
    activeCropOptions: agriculture.crops.map((crop) => ({
      value: crop.id,
      label: crop.label,
      selected: crop.id === agriculture.activeCropId
    })),
    cropRows,
    hasCrops: cropRows.length > 0,
    state,
    phaseLabel: PHASE_LABELS[state.phase] ?? state.phase,
    phaseOptions: AGRICULTURE_PHASES.map((phase) => ({ value: phase, label: PHASE_LABELS[phase], selected: state.phase === phase })),
    isEmpty: state.phase === "empty",
    isSowing: state.phase === "sowing",
    isGrowing: state.phase === "growing",
    isReady: state.phase === "ready" || state.phase === "harvesting",
    statusText: state.phase === "empty"
      ? "Участок свободен"
      : (state.phase === "sowing"
        ? `Посев ${state.sowingProgressQd}/${activeCrop?.sowingWorkQd ?? "?"} QD`
        : (state.phase === "growing"
          ? `Рост ${state.growingElapsedQd}/${activeCrop?.growingQd ?? "?"} QD`
          : `На участке ${state.readyQty} ед.; сбор ${state.harvestProgressQd}/${state.harvestWorkQdTotal} QD`)),
    outputRoomId,
    outputRoomOptions,
    gmPriority: agriculture.gmPriority,
    sow: agriculture.operations.sow,
    harvest: agriculture.operations.harvest,
    enabledPath: `${basePath}.agriculture.enabled`,
    activeCropIdPath: `${basePath}.agriculture.activeCropId`,
    outputRoomIdPath: `${basePath}.agriculture.outputRoomId`,
    gmPriorityPath: `${basePath}.agriculture.gmPriority`,
    sowPath: `${basePath}.agriculture.operations.sow`,
    harvestPath: `${basePath}.agriculture.operations.harvest`,
    phasePath: `${basePath}.agriculture.state.phase`,
    cropIdPath: `${basePath}.agriculture.state.cropId`,
    sowingProgressQdPath: `${basePath}.agriculture.state.sowingProgressQd`,
    growingElapsedQdPath: `${basePath}.agriculture.state.growingElapsedQd`,
    readyAgeQdPath: `${basePath}.agriculture.state.readyAgeQd`,
    harvestProgressQdPath: `${basePath}.agriculture.state.harvestProgressQd`,
    harvestWorkQdTotalPath: `${basePath}.agriculture.state.harvestWorkQdTotal`,
    harvestTotalQtyPath: `${basePath}.agriculture.state.harvestTotalQty`,
    harvestedQtyPath: `${basePath}.agriculture.state.harvestedQty`,
    readyQtyPath: `${basePath}.agriculture.state.readyQty`,
    sowingSeasonKeyPath: `${basePath}.agriculture.state.sowingSeasonKey`,
    readySeasonKeyPath: `${basePath}.agriculture.state.readySeasonKey`,
    lastSownSeasonKeyPath: `${basePath}.agriculture.state.lastSownSeasonKey`,
    lastMissedSowingSeasonKeyPath: `${basePath}.agriculture.state.lastMissedSowingSeasonKey`
  };
}
};
