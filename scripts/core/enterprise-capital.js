function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function wholeCopper(value, safeNumber = number) {
  const whole = Math.max(0, Math.floor(safeNumber(value, 0)));
  return Number.isSafeInteger(whole) ? whole : 0;
}

function sourceObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export const ENTERPRISE_CAPITAL_SCHEMA_VERSION = 2;

export const ENTERPRISE_CAPITAL_FIELDS = Object.freeze([
  "equipmentCopper",
  "workingCapitalCopper"
]);

export const ENTERPRISE_CAPITAL_FUNDING_PROVENANCES = Object.freeze([
  "treasury",
  "manual",
  "legacy",
  "mixed",
  "legacy-grandfathered"
]);

const FUNDING_PROVENANCES = new Set(ENTERPRISE_CAPITAL_FUNDING_PROVENANCES);
const V2_AUTHORITY_FIELDS = Object.freeze([
  "commissioningPaidCopper",
  "workingCapitalReserveCopper",
  "fundingProvenance",
  "legacyGrandfathered"
]);

export function normalizeEnterpriseCapital(source = {}, safeNumber = number) {
  const capital = sourceObject(source);
  const fundedCopper = wholeCopper(capital.fundedCopper, safeNumber);
  const legacyGrandfathered = capital.legacyGrandfathered === true;
  const rawProvenance = String(capital.fundingProvenance ?? "").trim();
  const fundingProvenance = legacyGrandfathered
    ? "legacy-grandfathered"
    : (FUNDING_PROVENANCES.has(rawProvenance) ? rawProvenance : (fundedCopper > 0 ? "legacy" : "treasury"));
  return {
    version: ENTERPRISE_CAPITAL_SCHEMA_VERSION,
    enabled: Boolean(capital.enabled),
    landCopper: wholeCopper(capital.landCopper, safeNumber),
    equipmentCopper: wholeCopper(capital.equipmentCopper, safeNumber),
    workingCapitalCopper: wholeCopper(capital.workingCapitalCopper, safeNumber),
    commissioningPaidCopper: wholeCopper(capital.commissioningPaidCopper, safeNumber),
    workingCapitalReserveCopper: wholeCopper(capital.workingCapitalReserveCopper, safeNumber),
    fundingProvenance,
    legacyGrandfathered,
    // Kept as an immutable compatibility witness. It is never interpreted as
    // a refundable reserve or as current treasury-backed funding by itself.
    fundedCopper,
    renewalPercentAnnual: Math.max(0, Math.min(100, safeNumber(capital.renewalPercentAnnual, 10))),
    notes: String(capital.notes ?? "")
  };
}

export function enterpriseCapitalRequired(source = {}, safeNumber = number) {
  const capital = normalizeEnterpriseCapital(source, safeNumber);
  return capital.equipmentCopper + capital.workingCapitalCopper;
}

export function enterpriseCapitalReferenceValue(source = {}, safeNumber = number) {
  const capital = normalizeEnterpriseCapital(source, safeNumber);
  return capital.landCopper + capital.equipmentCopper + capital.workingCapitalCopper;
}

export function enterpriseCapitalState(building = {}, safeNumber = number, { landRightsProvided = false } = {}) {
  const capital = normalizeEnterpriseCapital(building?.enterpriseCapital, safeNumber);
  const landRightRequired = capital.enabled && capital.landCopper > 0;
  const landRightReady = !landRightRequired || Boolean(landRightsProvided);
  const commissioningRequiredCopper = capital.equipmentCopper;
  const reserveRequiredCopper = capital.workingCapitalCopper;
  const requiredCopper = enterpriseCapitalRequired(capital, safeNumber);
  const nominalRequiredCopper = enterpriseCapitalReferenceValue(capital, safeNumber);
  const commissioningAppliedCopper = Math.min(commissioningRequiredCopper, capital.commissioningPaidCopper);
  const reserveAppliedCopper = Math.min(reserveRequiredCopper, capital.workingCapitalReserveCopper);
  const commissioningShortfallCopper = Math.max(0, commissioningRequiredCopper - commissioningAppliedCopper);
  const reserveShortfallCopper = Math.max(0, reserveRequiredCopper - reserveAppliedCopper);
  const shortfallCopper = commissioningShortfallCopper + reserveShortfallCopper;
  const commissioningReady = commissioningShortfallCopper <= 0;
  const reserveReady = reserveShortfallCopper <= 0;
  const grandfathered = capital.legacyGrandfathered && capital.fundingProvenance === "legacy-grandfathered";
  const hasAuthoritativeFunding = capital.commissioningPaidCopper > 0 || capital.workingCapitalReserveCopper > 0;
  const legacyFundingNeedsReview = capital.fundedCopper > 0
    && !grandfathered
    && !hasAuthoritativeFunding
    && capital.fundingProvenance === "legacy";
  const ready = !capital.enabled
    || grandfathered
    || (landRightReady && commissioningReady && reserveReady && !legacyFundingNeedsReview);
  const renewalBaseCopper = capital.equipmentCopper;
  const annualRenewalCopper = Math.ceil(renewalBaseCopper * capital.renewalPercentAnnual / 100);
  const appliedCopper = commissioningAppliedCopper + reserveAppliedCopper;
  const readinessBlockers = [];
  if (capital.enabled && !grandfathered) {
    if (!landRightReady) readinessBlockers.push("land-right");
    if (legacyFundingNeedsReview) readinessBlockers.push("legacy-funding-review");
    if (!commissioningReady) readinessBlockers.push("commissioning");
    if (!reserveReady) readinessBlockers.push("working-capital-reserve");
  }
  return {
    ...capital,
    landRightsProvided: Boolean(landRightsProvided),
    landRightRequired,
    landRightReady,
    landReferenceCopper: capital.landCopper,
    waivedLandCopper: landRightsProvided ? capital.landCopper : 0,
    nominalRequiredCopper,
    requiredCopper,
    cashRequiredCopper: requiredCopper,
    commissioningRequiredCopper,
    commissioningAppliedCopper,
    commissioningShortfallCopper,
    commissioningReady,
    reserveRequiredCopper,
    reserveAppliedCopper,
    reserveShortfallCopper,
    reserveReady,
    protectedReserveCopper: capital.workingCapitalReserveCopper,
    nonRefundableCommissioningCopper: capital.commissioningPaidCopper,
    committedCopper: capital.commissioningPaidCopper + capital.workingCapitalReserveCopper,
    appliedCopper,
    shortfallCopper,
    excessCommissioningCopper: Math.max(0, capital.commissioningPaidCopper - commissioningRequiredCopper),
    excessReserveCopper: Math.max(0, capital.workingCapitalReserveCopper - reserveRequiredCopper),
    legacyFundedCopper: capital.fundedCopper,
    unallocatedLegacyFundedCopper: Math.max(0, capital.fundedCopper - capital.commissioningPaidCopper - capital.workingCapitalReserveCopper),
    legacyFundingNeedsReview,
    grandfathered,
    renewalBaseCopper,
    annualRenewalCopper,
    renewalPerTendayCopper: annualRenewalCopper / 24,
    fundedPercent: grandfathered || requiredCopper <= 0 ? 100 : Math.max(0, Math.min(100, appliedCopper / requiredCopper * 100)),
    readinessBlockers,
    ready
  };
}

export function enterpriseCapitalReady(building = {}, safeNumber = number, options = {}) {
  return enterpriseCapitalState(building, safeNumber, options).ready;
}

function legacyBuildingCompleted(building = {}) {
  const status = String(building?.constructionStatus ?? building?.status ?? "").trim().toLocaleLowerCase("ru");
  const lifecycle = String(building?.lifecycle ?? "").trim().toLocaleLowerCase("en");
  const target = wholeCopper(building?.buildTarget);
  const progress = wholeCopper(building?.buildProgress);
  return /built|постро/.test(status) || lifecycle === "active" || (target > 0 && progress >= target);
}

/**
 * Pure, non-destructive planner for the V1 fundedCopper -> V2 split. It never
 * creates a reserve. Fully funded built legacy enterprises receive a readiness
 * grandfather; partial legacy funding is explicitly marked for GM review.
 */
export function planEnterpriseCapitalV2Migration(building = {}, safeNumber = number, { landRightsProvided = false } = {}) {
  const raw = sourceObject(building?.enterpriseCapital);
  const capital = normalizeEnterpriseCapital(raw, safeNumber);
  const hasV2Authority = wholeCopper(raw.version, safeNumber) >= ENTERPRISE_CAPITAL_SCHEMA_VERSION
    || V2_AUTHORITY_FIELDS.some((key) => Object.hasOwn(raw, key));
  if (hasV2Authority) return { needed: false, kind: "current", patch: {}, capital };

  const legacyRequiredCopper = capital.equipmentCopper
    + capital.workingCapitalCopper
    + (landRightsProvided ? 0 : capital.landCopper);
  const fullyFundedBuilt = capital.enabled
    && legacyBuildingCompleted(building)
    && legacyRequiredCopper > 0
    && capital.fundedCopper >= legacyRequiredCopper;
  if (fullyFundedBuilt) {
    return {
      needed: true,
      kind: "legacy-grandfathered",
      patch: {
        version: ENTERPRISE_CAPITAL_SCHEMA_VERSION,
        commissioningPaidCopper: capital.equipmentCopper,
        workingCapitalReserveCopper: 0,
        fundingProvenance: "legacy-grandfathered",
        legacyGrandfathered: true
      },
      capital
    };
  }

  return {
    needed: true,
    kind: capital.fundedCopper > 0 ? "legacy-review" : "unfunded",
    patch: {
      version: ENTERPRISE_CAPITAL_SCHEMA_VERSION,
      commissioningPaidCopper: 0,
      workingCapitalReserveCopper: 0,
      fundingProvenance: capital.fundedCopper > 0 ? "legacy" : "treasury",
      legacyGrandfathered: false
    },
    capital
  };
}
