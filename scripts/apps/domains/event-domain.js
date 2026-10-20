// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { AccessEventDomain } from "./events/access-events.js";
import { BuildingEventActions, BuildingEventDomain } from "./events/building-events.js";
import { EconomyEventActions, EconomyEventDomain } from "./events/economy-events.js";
import { FinanceControlEventActions, FinanceControlEventDomain } from "./events/finance-control-events.js";
import { GmEventActions, GmEventDomain } from "./events/gm-events.js";
import { NavigationEventActions, NavigationEventDomain } from "./events/navigation-events.js";
import { ResidentEventActions, ResidentEventDomain } from "./events/resident-events.js";
import { StorageEventActions, StorageEventDomain } from "./events/storage-events.js";
import { EventAutomationActions, EventAutomationDomain } from "./events/event-automation-events.js";
import { ResidentGeneratorEventDomain } from "./events/resident/generator-events.js";
import { composeDomainGroup } from "./compose-domain.js";
import { ShipEventActions, ShipEventDomain } from "./events/ship-events.js";

export const EventActionDefinitions = [
  ["ShipEventActions", ShipEventActions],
  ["NavigationEventActions", NavigationEventActions],
  ["ResidentEventActions", ResidentEventActions],
  ["BuildingEventActions", BuildingEventActions],
  ["EconomyEventActions", EconomyEventActions],
  ["FinanceControlEventActions", FinanceControlEventActions],
  ["StorageEventActions", StorageEventActions],
  ["EventAutomationActions", EventAutomationActions],
  ["GmEventActions", GmEventActions]
];

export const EventDomain = composeDomainGroup("EventDomain", [
  ["ShipEventDomain", ShipEventDomain],
  ["AccessEventDomain", AccessEventDomain],
  ["NavigationEventDomain", NavigationEventDomain],
  ["ResidentEventDomain", ResidentEventDomain],
  ["ResidentGeneratorEventDomain", ResidentGeneratorEventDomain],
  ["BuildingEventDomain", BuildingEventDomain],
  ["EconomyEventDomain", EconomyEventDomain],
  ["FinanceControlEventDomain", FinanceControlEventDomain],
  ["StorageEventDomain", StorageEventDomain],
  ["EventAutomationDomain", EventAutomationDomain],
  ["GmEventDomain", GmEventDomain]
]);
