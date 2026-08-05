import { TEMPLATE_CATALOG_VERSION } from "../../data/building-templates.js";
import { makeId } from "../../data/utils.js";

export function skyholdRandomId(prefix = "id", length = 8) {
  return makeId(prefix, length);
}

export function makeBlankBuildingTemplate(order = 1) {
  const id = skyholdRandomId("custom-template", 10);
  return {
    id,
    compendiumId: "",
    name: `Новый шаблон ${order}`,
    type: "Особые",
    primaryDev: "technology",
    icon: "fa-solid fa-drafting-compass",
    img: "",
    audio: { mode: "file", track: "", src: "", playlistId: "", soundId: "", volume: 0.45, loop: true },
    unlocked: true,
    visibility: "public",
    description: "",
    sourceRequirement: "",
    sourceRawMaterials: "",
    specialRequirements: "",
    requirements: { food: 0, technology: 0, culture: 0, war: 0 },
    bonuses: { food: 0, technology: 0, culture: 0, war: 0 },
    buildDifficulty: 0,
    buildTarget: 1,
    buildProgress: 0,
    constructionStatus: "planned",
    materialCosts: [],
    requiredBuildingIds: [],
    workersMin: 0,
    workersMax: 1,
    suitableWorkerTypes: "",
    workerTypeEffects: {},
    workerRole: "",
    workerPrimaryAttribute: "",
    functions: { production: false, income: false, defense: false, housing: false, storage: false, culture: false },
    productionLines: [],
    contents: [],
    income: {
      base: 0,
      perWorker: 0,
      formula: "",
      risk: 0,
      illegal: false,
      trade: { enabled: false, budgetFormula: "2d6*10", maxLotsPerBuyer: 1, roomId: "all", kind: "all", notes: "" }
    },
    defense: { base: 0, perStep: 0, workerStep: 0, combatTag: "garrison" },
    housing: { capacity: 0, comfort: 0, quality: 0, notes: "" },
    storage: { capacity: 0, security: 0, quality: 0 },
    religion: { religious: false, faith: "", customFaith: "", notes: "" },
    reputation: 0,
    moraleDelta: 0,
    workerMoraleDelta: 0,
    upkeep: 0,
    effect: "",
    notes: "",
    templateVersion: TEMPLATE_CATALOG_VERSION,
    custom: true
  };
}
