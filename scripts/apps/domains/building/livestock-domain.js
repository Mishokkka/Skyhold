import { livestockProfileForSpecies, normalizeLivestockBuilding } from "../../../data/livestock.js";
import { livestockHeadcount } from "../../../engines/economy/livestock.js";

const SEASON_LABELS = Object.freeze({
  spring: "Зарость I",
  summer: "Зарость II",
  autumn: "Ухудно I",
  winter: "Ухудно II"
});

function whole(value, fallback = 0) {
  const parsed = Number(value);
  return Math.max(0, Math.floor(Number.isFinite(parsed) ? parsed : fallback));
}

function text(value = "") {
  return String(value ?? "").trim();
}

function seasonLabel(value = "") {
  return SEASON_LABELS[text(value)] ?? (text(value) || "—");
}

export const BuildingLivestockDomain = {
_prepareLivestockBuildingView(holding, building, basePath = "", storageRooms = []) {
  const livestock = normalizeLivestockBuilding(building?.livestock, { building });
  if (!livestock) return null;
  const state = livestock.state;
  const profile = livestock.profile;
  const headcount = livestockHeadcount(state);
  const youngTotal = state.young.reduce((sum, cohort) => sum + whole(cohort?.qty), 0);
  const free = Math.max(0, profile.capacity - headcount);
  const outputRoomId = this._normalizeStorageRoomId?.(livestock.outputRoomId) ?? text(livestock.outputRoomId || "outdoors");
  const outputRoomOptions = this._storageRoomOptionsFromRooms?.(storageRooms, outputRoomId)
    ?? this._storageRoomOptions?.(holding, outputRoomId)
    ?? [{ value: "outdoors", label: "Под открытым небом", selected: true }];
  if (!outputRoomOptions.some((row) => row.value === "auto")) outputRoomOptions.unshift({ value: "auto", label: "Предпочтительные склады", selected: outputRoomId === "auto" });
  const grazingLabels = profile.grazingSeasons.map(seasonLabel);
  const feedRule = profile.headsPerFeedUnit > 1
    ? `1 Animal Feed на ${whole(profile.headsPerFeedUnit)} головы за десятник`
    : `${whole(profile.feedUnitsPerHead, 1)} Animal Feed на голову за десятник`;
  const youngRows = state.young.map((cohort, index) => ({
    ...cohort,
    index,
    number: index + 1,
    ageDays: Math.floor(whole(cohort.ageQd) / 4),
    qtyPath: `${basePath}.livestock.state.young.${index}.qty`,
    ageQdPath: `${basePath}.livestock.state.young.${index}.ageQd`,
    canGrow: whole(cohort.ageQd) < profile.maturityQd
  }));

  return {
    enabled: livestock.enabled,
    speciesId: livestock.speciesId,
    speciesOptions: livestock.speciesOptions.map((speciesId) => ({
      value: speciesId,
      label: livestockProfileForSpecies(speciesId)?.label ?? speciesId,
      selected: speciesId === livestock.speciesId
    })),
    canSelectSpecies: livestock.speciesOptions.length > 1,
    speciesLabel: profile.label,
    marketPriceCopper: profile.marketPriceCopper,
    marketPriceLabel: `${whole(profile.marketPriceCopper).toLocaleString("ru-RU")} ММ`,
    headcount,
    capacity: profile.capacity,
    free,
    fillPercent: Math.max(0, Math.min(100, Math.round(headcount / Math.max(1, profile.capacity) * 100))),
    adults: state.adults,
    adultsMaximum: Math.max(0, profile.capacity - youngTotal),
    breedingMales: state.breedingMales,
    youngTotal,
    youngRows,
    hasYoung: youngRows.length > 0,
    canAddYoung: free > 0,
    woolReady: state.woolReady,
    lastBirthSeasonKey: state.lastBirthSeasonKey,
    lastWoolSeasonKey: state.lastWoolSeasonKey,
    maturityQd: profile.maturityQd,
    maturityDays: Math.ceil(profile.maturityQd / 4),
    feedResourceId: profile.feedResourceId,
    feedRuleText: grazingLabels.length
      ? `Без корма: ${grazingLabels.join(", ")}; в остальные сезоны — ${feedRule}.`
      : `Корм круглый год: ${feedRule}.`,
    breedingSeasonLabel: seasonLabel(profile.breedingSeasonId),
    shearingSeasonLabel: profile.producesWool ? seasonLabel(profile.shearingSeasonId) : "—",
    careWorkQdPerDay: profile.careWorkQdPerDay,
    producesEggs: profile.producesEggs,
    producesMilk: profile.producesMilk,
    producesWool: profile.producesWool,
    eggResourceId: profile.eggResourceId,
    eggPerFullFlockDay: profile.eggPerFullFlockDay,
    milkResourceId: profile.milkResourceId,
    woolResourceId: profile.woolResourceId,
    meatResourceId: profile.meatResourceId,
    milkPerHeadDay: profile.milkPerHeadDay,
    milkPerFullFlockDay: profile.milkPerFullFlockDay,
    milkWorkQdPerHeadDay: profile.milkWorkQdPerHeadDay,
    woolPerHead: profile.woolPerHead,
    shearWorkQdPerHead: profile.shearWorkQdPerHead,
    meatPerAdult: profile.meatPerAdult,
    tallowPerAdult: profile.tallowPerAdult,
    slaughterWorkQdPerHead: profile.slaughterWorkQdPerHead,
    eggs: livestock.operations.eggs,
    milk: livestock.operations.milk,
    shearQty: livestock.operations.shearQty,
    slaughterQty: livestock.operations.slaughterQty,
    slaughterBreedingMales: livestock.operations.slaughterBreedingMales,
    feedPriority: livestock.operations.feedPriority,
    feedPriorityAdults: livestock.operations.feedPriority !== "young",
    feedPriorityYoung: livestock.operations.feedPriority === "young",
    gmPriority: livestock.gmPriority,
    outputRoomId,
    outputRoomOptions,
    enabledPath: `${basePath}.livestock.enabled`,
    speciesIdPath: `${basePath}.livestock.speciesId`,
    adultsPath: `${basePath}.livestock.state.adults`,
    breedingMalesPath: `${basePath}.livestock.state.breedingMales`,
    eggsPath: `${basePath}.livestock.operations.eggs`,
    milkPath: `${basePath}.livestock.operations.milk`,
    shearQtyPath: `${basePath}.livestock.operations.shearQty`,
    slaughterQtyPath: `${basePath}.livestock.operations.slaughterQty`,
    slaughterBreedingMalesPath: `${basePath}.livestock.operations.slaughterBreedingMales`,
    feedPriorityPath: `${basePath}.livestock.operations.feedPriority`,
    gmPriorityPath: `${basePath}.livestock.gmPriority`,
    outputRoomIdPath: `${basePath}.livestock.outputRoomId`
  };
}
};
