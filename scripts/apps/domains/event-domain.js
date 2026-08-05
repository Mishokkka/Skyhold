// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { AccessEventDomain } from "./events/access-events.js";
import { BuildingEventActions, BuildingEventDomain } from "./events/building-events.js";
import { EconomyEventActions, EconomyEventDomain } from "./events/economy-events.js";
import { GmEventActions, GmEventDomain } from "./events/gm-events.js";
import { NavigationEventActions, NavigationEventDomain } from "./events/navigation-events.js";
import { ResidentEventActions, ResidentEventDomain } from "./events/resident-events.js";
import { StorageEventActions, StorageEventDomain } from "./events/storage-events.js";
import { EventAutomationActions, EventAutomationDomain } from "./events/event-automation-events.js";
import { ResidentGeneratorEventDomain } from "./events/resident/generator-events.js";
import { FleetEventActions, FleetEventDomain } from "./events/fleet-events.js";
import { composeDomainGroup } from "./compose-domain.js";

export const EventActionDefinitions = [
  ["NavigationEventActions", NavigationEventActions],
  ["ResidentEventActions", ResidentEventActions],
  ["BuildingEventActions", BuildingEventActions],
  ["EconomyEventActions", EconomyEventActions],
  ["StorageEventActions", StorageEventActions],
  ["FleetEventActions", FleetEventActions],
  ["EventAutomationActions", EventAutomationActions],
  ["GmEventActions", GmEventActions]
];

export const EventDomain = composeDomainGroup("EventDomain", [
  ["AccessEventDomain", AccessEventDomain],
  ["NavigationEventDomain", NavigationEventDomain],
  ["ResidentEventDomain", ResidentEventDomain],
  ["ResidentGeneratorEventDomain", ResidentGeneratorEventDomain],
  ["BuildingEventDomain", BuildingEventDomain],
  ["EconomyEventDomain", EconomyEventDomain],
  ["StorageEventDomain", StorageEventDomain],
  ["FleetEventDomain", FleetEventDomain],
  ["EventAutomationDomain", EventAutomationDomain],
  ["GmEventDomain", GmEventDomain]
]);
