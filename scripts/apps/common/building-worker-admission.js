import { escapeHtml } from "../../core/helpers.js";
import { foundryDialogV2 } from "../../integrations/foundry-runtime.js";

export async function confirmBuildingWorkerAdmission({ manager, building, person }) {
  if (!person) return { allowed: true, allowAdmissionOverride: false };
  const admission = manager?._buildingWorkerAdmission?.(building, person) ?? { eligible: true, hard: false, overridden: false };
  if (!admission.hard || admission.eligible || admission.overridden) return { allowed: true, allowAdmissionOverride: false };
  if (!globalThis.game?.user?.isGM) {
    globalThis.ui?.notifications?.warn?.(`Работник не проходит обязательный допуск: ${admission.text}.`);
    return { allowed: false, allowAdmissionOverride: false };
  }
  const confirmed = await foundryDialogV2().confirm({
    window: { title: "Назначить с GM-допуском?" },
    content: `<p><strong>${escapeHtml(person.name || "Работник")}</strong> не выполняет обязательное условие: <strong>${escapeHtml(admission.text)}</strong>.</p><p>Назначить как явное исключение? Работник сможет занимать это место, но не получит квалификационных бонусов.</p>`,
    modal: true
  });
  return { allowed: Boolean(confirmed), allowAdmissionOverride: Boolean(confirmed) };
}
