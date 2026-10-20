import { BASE_HOLDING } from "../schema/base-holding.js";
import { clone } from "../utils.js";

export const MAGNIFIC_PRESET = {
  ...clone(BASE_HOLDING),
  id: "magnific",
  name: "Магнифик",
  type: "ship",
  owner: "Адмирал Элина Траззмар",
  visibility: "public",
  overview: {
    ...clone(BASE_HOLDING.overview),
    status: "В строю",
    period: "Не задано",
    description: "Летающий корабль адмирала Элины Траззмар. Может вести экипаж, груз, рейсы и доходы.",
    publicNotes: "На следующих этапах сюда можно добавить контрабандистские заплывы, риск, доход и состояние корпуса.",
    mechanisms: "Корабельные системы",
    weather: "По маршруту"
  },
  people: {
    ...clone(BASE_HOLDING.people),
    notes: "Экипаж, офицеры, специалисты, пассажиры и наемники Магнифика."
  },
  buildings: {
    ...clone(BASE_HOLDING.buildings),
    notes: "Для корабля эта вкладка может хранить отсеки, узлы, вооружение и улучшения."
  },
  storage: {
    ...clone(BASE_HOLDING.storage),
    notes: "Груз, припасы, контрабанда, топливо, деньги и корабельное имущество."
  }
};
