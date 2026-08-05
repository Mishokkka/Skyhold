import { HoldingDomain } from "../apps/domains/holding-domain.js";
import { ResidentDomain } from "../apps/domains/resident-domain.js";
import { BuildingDomain } from "../apps/domains/building-domain.js";
import { AssignmentDomain } from "../apps/domains/assignment-domain.js";
import { FinanceDomain } from "../apps/domains/finance-domain.js";
import { EconomyEventDomain } from "../apps/domains/events/economy-events.js";
import { EventAutomationDomain } from "../apps/domains/events/event-automation-events.js";
import { GmEventDomain } from "../apps/domains/events/gm-events.js";
import { assignDomainGroup } from "../apps/domains/compose-domain.js";
import { requestSkyholdAppRender } from "../apps/registry.js";

export class SkyholdWorkflowService {
  _safeNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  requestRender(options = {}) {
    return requestSkyholdAppRender({ focus: false, ...options });
  }
}

assignDomainGroup(SkyholdWorkflowService.prototype, "SkyholdWorkflowService", [
  ["HoldingDomain", HoldingDomain],
  ["ResidentDomain", ResidentDomain],
  ["BuildingDomain", BuildingDomain],
  ["AssignmentDomain", AssignmentDomain],
  ["FinanceDomain", FinanceDomain],
  ["EconomyEventDomain", EconomyEventDomain],
  ["EventAutomationDomain", EventAutomationDomain],
  ["GmEventDomain", GmEventDomain]
]);

let workflowService = null;

export function getSkyholdWorkflowService() {
  workflowService ??= new SkyholdWorkflowService();
  return workflowService;
}
