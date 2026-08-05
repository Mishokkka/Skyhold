import { BASE_HOLDING } from "../schema/base-holding.js";
import { clone } from "../utils.js";

export const RESTORATION_SETTLEMENT_PRESET = {
  ...clone(BASE_HOLDING),
  id: "restoration-settlement",
  name: "Восстанавливаемое поселение",
  type: "settlement",
  owner: "Игроки",
  visibility: "public",
  overview: {
    ...clone(BASE_HOLDING.overview),
    status: "Восстановление",
    period: "Не задано",
    description: "Будущее поселение игроков. Сейчас это заготовка под восстановление.",
    publicNotes: "Здесь позже появятся руины, пригодное жилье, рабочие руки и угрозы территории."
  }
};
