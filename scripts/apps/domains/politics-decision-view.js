import { politicsReadyFood } from "../../engines/politics/decree-payment.js";
import { changePoliticsDirective, politicsAllowedSlots, politicsDecreePreflight, politicsRowBlockReasons } from "../../engines/politics/rules.js";

export function politicsDecisionView(holding, { state, catalog, balance, periodIndex, context, archetypeId, summary, slotMeta }) {
  const allowed = politicsAllowedSlots(state, balance);
  const population = (holding.people?.list ?? []).filter((person) => !person.dead).length;
  const conditions = { ...context, archetypeId, balance, periodIndex, population,
    moneyCopper: holding.storage?.moneyCopper, foodAvailable: politicsReadyFood(holding) };
  const courseDecrees = catalog.filter((row) => row.kind === "decree" && row.enabled !== false).map((row) => {
    const id = row.id.startsWith("custom-") ? row.id : row.id.slice(7);
    const preflight = politicsDecreePreflight(state, { ...conditions, decreeId: id });
    const food = preflight.quote?.food ?? row.foodPerResident * population;
    const nextAllowed = Math.max(Number(state.decreeCooldownUntil[id]) || 0,
      ...(state.activeDecrees ?? []).filter((entry) => entry.decreeId === id).map((entry) => Number(entry.expiresPeriodIndex) || 0));
    return { id, label: row.label, effect: summary(row), summary: row.summary,
      price: `${row.copper} ММ · ${row.influence} Влияния${food ? ` · ${food} пищи (${population} × ${row.foodPerResident})` : ""}`,
      term: `${row.duration} десятник(ов), до ${periodIndex + row.duration}`, copper: row.copper,
      influence: row.influence, foodPerResident: row.foodPerResident, food,
      nextAllowedPeriodIndex: nextAllowed > periodIndex ? nextAllowed : null,
      unlocked: preflight.ok, reason: preflight.reason ?? "",
      suitable: !row.archetypeId || row.archetypeId === archetypeId };
  });
  const courseSlots = Object.keys(slotMeta).map((id) => {
    const rows = catalog.filter((row) => row.kind === "directive" && row.enabled !== false && (!row.slot || row.slot === id));
    const changed = state.directiveChangedPeriodIndex[id] === periodIndex;
    const option = (directiveId, row = null) => {
      const check = changePoliticsDirective(state, { ...conditions, slot: id, directiveId, requirements: context });
      return { id: directiveId, label: row?.label ?? "Обычный порядок", summary: row ? summary(row) : "Без политического эффекта",
        selected: state.directives[id] === directiveId, unlocked: check.ok, reason: check.reason ?? "" };
    };
    const options = [option(""), ...rows.map((row) => option(row.id.startsWith("custom-") ? row.id : row.id.slice(10), row))];
    if (state.directives[id] && !options.some((row) => row.id === state.directives[id])) options.push({ id: state.directives[id], label: `Вне каталога: ${state.directives[id]}`, selected: true, unlocked: false, reason: "Запись сохранена без действующего эффекта." });
    return { id, ...slotMeta[id], allowed: allowed.includes(id), canChange: context.available && allowed.includes(id) && !changed,
      reason: !context.available ? "Политика приостановлена." : !allowed.includes(id) ? "Слот закрыт текущей властью." : changed ? `Слот уже изменён. Следующее изменение — в десятнике ${periodIndex + 1}.` : "",
      selectedLabel: options.find((row) => row.selected)?.label ?? "Обычный порядок", options };
  });
  return { courseSlots, courseDecrees: courseDecrees.filter((row) => row.suitable), otherDecrees: courseDecrees.filter((row) => !row.suitable),
    systemReasons: Object.fromEntries(catalog.filter((row) => row.kind === "system").map((row) => [row.id, politicsRowBlockReasons(row, context).join(" ")])) };
}
