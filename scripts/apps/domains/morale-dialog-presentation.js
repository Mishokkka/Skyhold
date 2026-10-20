import { escapeHtml } from "../../core/helpers.js";

const MORALE_TONES = new Set(["riot", "bad", "low", "neutral", "hope", "home"]);

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function signed(value) {
  const total = number(value, 0);
  return `${total > 0 ? "+" : ""}${total}`;
}

function tone(value) {
  const key = String(value ?? "neutral");
  return MORALE_TONES.has(key) ? key : "neutral";
}

function summaryCard({ icon, label, value, note }) {
  return `<article class="fbls-morale-source">
    <i class="${escapeHtml(icon)}" aria-hidden="true"></i>
    <span>${escapeHtml(label)}<small>${escapeHtml(note)}</small></span>
    <strong>${escapeHtml(signed(value))}</strong>
  </article>`;
}

function renderThreshold(row = {}) {
  return `<article class="fbls-morale-level tone-${tone(row.css)}${row.current ? " is-current" : ""}">
    <div class="fbls-morale-level__title">
      <i class="${escapeHtml(row.icon || "fa-solid fa-face-meh")}" aria-hidden="true"></i>
      <strong>${escapeHtml(row.label || "Уровень")}</strong>
      ${row.current ? "<span>Сейчас</span>" : ""}
    </div>
    <b>${escapeHtml(row.range || "—")}</b>
    <p>${escapeHtml(row.notes || "—")}</p>
  </article>`;
}

function renderGmDetails(residents = [], buildings = []) {
  const residentRows = residents.map((row) => `<li>
    <span><strong>${escapeHtml(row.name || "Житель")}</strong><small>${escapeHtml((row.breakdown ?? []).join(" · ") || "Нет модификаторов")}</small></span>
    <b>${escapeHtml(signed(row.total))}</b>
  </li>`).join("");
  const buildingRows = buildings.map((row) => {
    let note = "Учтено полностью";
    if (row.leisure) note = `Досуг: мощность ${number(row.capacity)} × ${Math.round(number(row.diversityFactor, 1) * 100)}% = ${signed(row.value)}; заведение №${number(row.rank, 1)} своего вида`;
    else if (row.repeated && !row.repeatAllowed) note = "Повторный эффект не учитывается";
    else if (row.repeated) note = row.raw === row.value
      ? "Повторный эффект разрешён"
      : `Повторный эффект разрешён; ${signed(row.raw)} скорректировано до ${signed(row.value)}`;
    else if (row.coverage < 1 && row.coverage >= 0) {
      note = row.coverageTarget > 0
        ? `Охват ${number(row.capacity, 0)} из ${number(row.coverageTarget, 0)}`
        : `Охват ${Math.round(number(row.coverage, 0) * 100)}%`;
    } else if (row.raw !== row.value) note = `${signed(row.raw)} скорректировано до ${signed(row.value)}`;
    return `<li>
      <span><strong>${escapeHtml(row.name || "Здание")}</strong><small>${escapeHtml(note)}</small></span>
      <b>${escapeHtml(signed(row.value))}</b>
    </li>`;
  }).join("");

  return `<details class="fbls-morale-details">
    <summary><i class="fa-solid fa-user-group" aria-hidden="true"></i> Жители по отдельности <span>${residents.length}</span></summary>
    <ul>${residentRows || "<li class=\"is-empty\">Нет живых жителей.</li>"}</ul>
  </details>
  <details class="fbls-morale-details">
    <summary><i class="fa-solid fa-building" aria-hidden="true"></i> Здания по отдельности <span>${buildings.length}</span></summary>
    <ul>${buildingRows || "<li class=\"is-empty\">Нет учитываемых зданий.</li>"}</ul>
  </details>`;
}

export function renderMoraleDialog(context = {}) {
  const rawMorale = number(context.rawMorale, 0);
  const state = context.state ?? {};
  const control = context.control ?? {};
  const sources = context.sources ?? {};
  const ceiling = control.institutionalCeiling === null || control.institutionalCeiling === undefined
    ? "Нет полного охвата"
    : signed(control.institutionalCeiling);
  const controlChanged = number(control.disorderMorale, rawMorale) !== rawMorale;

  const sourceCards = [
    summaryCard({ icon: "fa-solid fa-people-group", label: "Жители", value: sources.people, note: `${number(sources.population, 0)} чел.` }),
    summaryCard({ icon: "fa-solid fa-building", label: "Здания", value: sources.buildings, note: "действующие эффекты" }),
    summaryCard({ icon: "fa-solid fa-wand-magic-sparkles", label: "Прочие поправки", value: sources.specialAndGm, note: "особые и ручные эффекты" })
  ].join("");

  const levels = (context.levels ?? []).map(renderThreshold).join("");
  const gmDetails = context.isGm
    ? `<section class="fbls-morale-section fbls-morale-gm" aria-label="Подробности для ГМ">
        <header><span><i class="fa-solid fa-eye" aria-hidden="true"></i> Только ГМ</span><small>Источники показаны без изменения данных.</small></header>
        ${renderGmDetails(context.residents ?? [], context.buildings ?? [])}
      </section>`
    : "";

  return `<div class="fbls-morale-dialog__scroll">
    <section class="fbls-morale-hero tone-${tone(state.css)}" aria-label="Текущее довольство">
      <div class="fbls-morale-hero__value"><i class="${escapeHtml(state.icon || "fa-solid fa-face-smile")}" aria-hidden="true"></i><strong>${escapeHtml(String(rawMorale))}</strong></div>
      <div class="fbls-morale-hero__copy">
        <small>${escapeHtml(context.holdingName || "Поселение")}</small>
        <h2>${escapeHtml(state.label || "Довольство")}</h2>
        <p>${escapeHtml(state.notes || "—")}</p>
      </div>
      <span class="fbls-morale-hero__range">${escapeHtml(state.range || "—")}</span>
    </section>

    <section class="fbls-morale-section" aria-label="Из чего складывается довольство">
      <header><span><i class="fa-solid fa-chart-simple" aria-hidden="true"></i> Из чего складывается</span><small>Сумма всех действующих источников</small></header>
      <div class="fbls-morale-sources">${sourceCards}</div>
      <div class="fbls-morale-equation">
        <span>${escapeHtml(signed(sources.people))}</span><i class="fa-solid fa-plus" aria-hidden="true"></i>
        <span>${escapeHtml(signed(sources.buildings))}</span><i class="fa-solid fa-plus" aria-hidden="true"></i>
        <span>${escapeHtml(signed(sources.specialAndGm))}</span><i class="fa-solid fa-equals" aria-hidden="true"></i>
        <strong>${escapeHtml(String(rawMorale))}</strong>
      </div>
    </section>

    <section class="fbls-morale-section" aria-label="Довольство и контроль">
      <header><span><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> Довольство и Контроль</span><small>Контроль влияет только на риск беспорядков</small></header>
      <div class="fbls-morale-control">
        <article><small>Сырое довольство</small><strong>${escapeHtml(String(rawMorale))}</strong><span>Определяет обычные эффекты уровня</span></article>
        <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
        <article class="${controlChanged ? "is-adjusted" : ""}"><small>Для беспорядков</small><strong>${escapeHtml(String(number(control.disorderMorale, rawMorale)))}</strong><span>${controlChanged ? "Смягчено институтами" : "Без изменения"}</span></article>
      </div>
      <div class="fbls-morale-control__facts">
        <span><i class="fa-solid fa-scale-balanced" aria-hidden="true"></i> Общий Контроль <b>${escapeHtml(String(number(control.generalControl, 0)))}/${escapeHtml(String(number(control.orderRequirement, 0)))}</b></span>
        <span><i class="fa-solid fa-people-roof" aria-hidden="true"></i> Против беспорядков <b>+${escapeHtml(String(number(control.unrestOnlyControl, 0)))}</b></span>
        <span><i class="fa-solid fa-arrow-up-right-dots" aria-hidden="true"></i> Потолок <b>${escapeHtml(ceiling)}</b></span>
      </div>
      <p class="fbls-morale-control__note">Контроль не добавляет довольство и не меняет его обычные бонусы или штрафы. Он может повысить только значение для проверки беспорядков, если учреждения охватывают всё население.</p>
    </section>

    <section class="fbls-morale-section" aria-label="Шкала довольства">
      <header><span><i class="fa-solid fa-gauge-high" aria-hidden="true"></i> Шкала уровней</span><small>Текущий уровень выделен</small></header>
      <div class="fbls-morale-levels">${levels}</div>
    </section>
    ${gmDetails}
  </div>`;
}
