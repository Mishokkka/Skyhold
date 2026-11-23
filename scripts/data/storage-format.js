import { TEMPLATE_CATALOG_VERSION } from "./building-templates.js";
import { SKYHOLD_SCHEMA_VERSION } from "./schema-version.js";
import { isPlainObject } from "./utils.js";

export const UNSUPPORTED_WORLD_DATA = "unsupported-world-data";

function savedVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : null;
}

/** Validate the selected on-disk root before normalization can replace its version metadata. */
export function assertSupportedWorldData(data) {
  const schema = savedVersion(data?.meta?.schemaVersion);
  const catalog = savedVersion(data?.meta?.templateCatalogVersion);
  if (schema === SKYHOLD_SCHEMA_VERSION && catalog === TEMPLATE_CATALOG_VERSION
    && Array.isArray(data?.holdings) && isPlainObject(data.catalog)) return;

  const newer = schema > SKYHOLD_SCHEMA_VERSION || catalog > TEMPLATE_CATALOG_VERSION;
  const guidance = newer
    ? "Установите версию Skyhold, поддерживающую это сохранение."
    : "Для старого сохранения используйте копию мира и предыдущую версию Skyhold с миграциями (коммит 830a292). Для повреждённого сохранения восстановите рабочую резервную копию.";
  const message = `Skyhold не может открыть сохранение (схема ${schema ?? "не указана"}, каталог ${catalog ?? "не указан"}). Требуются схема ${SKYHOLD_SCHEMA_VERSION} и каталог ${TEMPLATE_CATALOG_VERSION}. ${guidance}`;
  throw Object.assign(new Error(message), { code: UNSUPPORTED_WORLD_DATA });
}
