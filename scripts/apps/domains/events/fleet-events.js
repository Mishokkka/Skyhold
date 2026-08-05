import { createFleetVessel, FLEET_SCHEMA_VERSION } from "../../../data/normalizers/fleet.js";
import { SkyholdData } from "../../../data/store.js";
import { openShipEnterpriseApp } from "../../lazy-apps.js";

export const FleetEventActions = {
  click: {
    "create-fleet-vessel": "_onCreateFleetVessel",
    "open-ship-enterprise": "_onOpenShipEnterprise"
  },
  publicClick: ["open-ship-enterprise"]
};

export const FleetEventDomain = {
  async _onCreateFleetVessel(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const data = SkyholdData.get();
    const holdingId = this._activeWritableHoldingId(data);
    if (!holdingId) return;
    const result = await SkyholdData.updateHolding(holdingId, (holding) => {
      if (!holding.special || typeof holding.special !== "object") holding.special = {};
      if (!holding.special.fleet || typeof holding.special.fleet !== "object") {
        holding.special.fleet = { schemaVersion: FLEET_SCHEMA_VERSION, activeVesselId: "", vessels: [], transfers: [] };
      }
      if (!Array.isArray(holding.special.fleet.vessels)) holding.special.fleet.vessels = [];
      const first = holding.special.fleet.vessels.length === 0;
      const vessel = createFleetVessel({
        holdingId: holding.id,
        name: first ? "Магнифик" : "Новое судно",
        ownerName: first ? "Элина Траззмар" : ""
      });
      holding.special.fleet.vessels.push(vessel);
      holding.special.fleet.activeVesselId = vessel.id;
      return { ok: true, vesselId: vessel.id };
    }, { fallback: false, reason: "fleet:create-vessel" });
    if (!result?.ok) return ui.notifications.warn(result?.message || "Не удалось создать корабль.");
    this.activeSpecialTab = "fleet";
    this.requestRender({ focus: false });
    ui.notifications.info("Корабль добавлен в предприятие поселения.");
  },

  async _onOpenShipEnterprise(event) {
    event.preventDefault();
    event.stopPropagation();
    const data = SkyholdData.get();
    const holdingId = this._activeWritableHoldingId(data)
      || String(this.activeHoldingId ?? "")
      || String(data?.holdings?.[0]?.id ?? "");
    if (!holdingId) return;
    const vesselId = String(event.currentTarget?.dataset?.vesselId ?? "");
    await openShipEnterpriseApp({ holdingId, vesselId, owner: this });
  }
};
