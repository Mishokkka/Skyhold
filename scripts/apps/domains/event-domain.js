// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { AccessEventDomain } from "./events/access-events.js";
import { BuildingEventDomain } from "./events/building-events.js";
import { EconomyEventDomain } from "./events/economy-events.js";
import { GmEventDomain } from "./events/gm-events.js";
import { NavigationEventDomain } from "./events/navigation-events.js";
import { ResidentEventDomain } from "./events/resident-events.js";
import { StorageEventDomain } from "./events/storage-events.js";

export const EventDomain = {
  ...AccessEventDomain,
  ...NavigationEventDomain,
  ...ResidentEventDomain,
  ...BuildingEventDomain,
  ...EconomyEventDomain,
  ...StorageEventDomain,
  ...GmEventDomain
};
