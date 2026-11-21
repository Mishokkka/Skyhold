# Формат Content Pack (`fbl-skyhold.content-pack`, v1)

JSON-файл для контролируемого импорта данных мира через **GM → Content packs** (нормализация → Preview с проверкой ревизии → подтверждение → запись `content-import` в timeline). Чтение файла мир не меняет; миграция каталога зданий и переход труда выполняются отдельно ([migrations.md](migrations.md)).

## Манифест и конфликты

```json
{
  "schema": "fbl-skyhold.content-pack",
  "formatVersion": 1,
  "id": "my-pack",
  "source": "author.my-pack",
  "version": 1,
  "name": "Мой набор",
  "description": "Описание",
  "install": {
    "replaceMarket": false,
    "replaceResources": false,
    "overwriteResources": false
  },
  "content": {
    "buildings": [],
    "resources": [],
    "events": { "general": [], "external": [] },
    "regions": [],
    "doctrines": [],
    "marketRouteMap": {},
    "retire": [],
    "marketEconomy": {
      "baseOffers": [], "countries": [], "specialties": [],
      "organizations": [], "sizeProfiles": [], "conditions": []
    }
  }
}
```

- Каждый раздел необязателен и ограничен **500 строками** (устаревший `content.markets` не поддерживается и очищается нормализацией без миграции).
- Каждая строка имеет стабильный `id` (у региона допустим `value`); `contentSource` / `contentVersion` строки переопределяют корневые.
- Политика слияния: `add` (новый id), `update` (тот же `source` и более высокая версия), `skip` (равная/новее), `conflict` (другой `source` — требует выбора ГМа). Отсутствующие в пакете строки не удаляются.
- **Безопасное удаление (`content.retire`):** `{ "kind": "regions", "id": "old-id", "sources": ["author.pack"] }` — автоматически удаляет запись только при совпадении `kind`, `id` и `contentSource` (чужие записи дают конфликт). Поддерживаются все разделы, кроме одиночного `marketRouteMap`.
- **Режимы установки (`install`, корневой объект — необязателен):**
  - `replaceMarket: true` — перед установкой очищает `catalog.marketEconomy`, legacy `catalog.markets`, рыночные локации, карту и связи; **открывает дополнительный диалог подтверждения ГМа** («Чистая установка набора»).
  - `replaceResources: true` — перед установкой очищает весь пользовательский `catalog.resources` (материалы, отсутствующие в пакете, удаляются; перед запуском нужен экспорт мира); **открывает дополнительный диалог подтверждения ГМа**.
  - `overwriteResources: true` — без `replaceResources` заменяет только совпавшие по `id` ресурсы в рамках обычного Preview, сохраняя остальные; **дополнительный диалог подтверждения не открывает**.
  - Владения, складские остатки, деньги, здания, жители и история не очищаются (но удаление определения ресурса через `replaceResources` может оставить складскую строку без прежнего каталожного описания).

## Слоистая модель рынка (`content.marketEconomy`)

Порядок расчёта локации: `baseOffers` → `countries` → `specialties` → `sizeProfiles` + `conditions` → `organizations` → маршрут и перевозчик. Несколько локаций могут ссылаться на один `countryId`.

### `baseOffers`
- `sourceType: "resource"` наследует `basePriceCopper` и `loadPoints` (`load = loadPoints / 4`) из `content.resources`. Поля: `id`, `active`, `visibility`, `sourceType`, `resourceId`, `kind`, `unit`, `priceFactor`, `priceOverrideCopper` (если нужна особая фикс. цена), `baseStock`, `volatility`, `ubiquity` (`essential` | `common` | `ordinary` | `specialized` | `restricted`), `forceAvailable`, `tags`, `priceBasis`, `historicalSource`, `availabilityNotes`.
- `sourceType: "item"` задаёт `itemUuid`, обязательные `priceOverrideCopper` и `loadOverridePoints` (при заказе сохраняется снимок Item).
- Уникальные `offers` внутри страны или специализации считаются характерными и доступными принудительно.

### `countries`, `specialties`, `sizeProfiles`, `conditions`
- **`countries`:** `id`, `label`, `active`, `visibility`, `description`, `conditionId`, `tradeRegime`, `taxRate` (0–1), `priceFactor`, `stockFactor`, `deliveryFactor`, `timeFactor`, `riskFactor`, `tags`, `rules`, `offers`. Коэффициенты применяются поверх `conditionId`.
- **`specialties`:** `id`, `label`, `category`, `description`, `active`, `rules`, `offers`. Правило: `{ id, label, active, mode: "adjust"|"produce"|"consume"|"restrict", targetTags, resourceIds, stockFactor, priceFactor, volatilityFactor, notes }`. Совпадение по любому `resourceId` или тегу (теги предложения, id/категория ресурса, вид, `materialGroups`). Встроенный каталог содержит 115 редактируемых специализаций.
- **`sizeProfiles`:** `id`, `label`, `description`, `active`, `maxUbiquity`, `stockFactor`, `priceFactor`, `handlingFactor`.
- **`conditions`:** `id`, `label`, `description`, `active`, `priceFactor`, `stockFactor`, `deliveryFactor`, `timeFactor`, `riskFactor`, `volatilityFactor` (применяется к стране и вторым слоем к локации).
- Глобальные `marketEconomy.settings` редактируются в GM-редакторе и используются [перевозками](transport-contract.md).

### `organizations`
Поля: `id`, `label`, `active`, `visibility`, `description`, `icon`, `tags` и три независимые роли:
- `merchant`: `{ enabled, countryShares: [{ countryId, sharePct, active }], includeTags, excludeTags, priceFactor, priceVolatility, stockStability }` — задаёт личность продавца без деления/клонирования общего запаса; остаток доли — независимые торговцы (сумма > 100% нормализуется).
- `buyer`: `{ enabled, countryShares, includeTags, excludeTags }` — личность покупателя исходящего товара на общем конечном demand.
- `carrier`: `{ enabled, countryShares: [{ countryId, sharePct, modeShares: { caravan, rail, airship }, active }], modes, priceFactor, timeFactor, riskFactor, capacityFactor }` — перевозчик, доступный только если поддерживает весь маршрут.

## Локации, карта и прочий контент

- **`content.regions`:** узел событий и рыночной карты: `id`/`value`, `label`, `aliases`, `countryId`, `marketEnabled`, `marketSizeId`, `marketSpecialtyIds`, `marketConditionId` (пустой наследует страну), `marketTags`, `marketLandmassId`, `marketAirshipOnly`, `marketTransportModes`, `marketLinks: [{ regionId, routeId?, distanceKm, modes, ursCost?, seasonalModifiers? }]`, `marketMapX/Y`, локальные факторы (`marketPriceFactor`, `marketAvailabilityFactor`, `marketDeliveryFactor`, `marketTimeFactor`, `marketRiskFactor`, `marketExportFactor`, `marketImportFactor`, `marketTaxRate`, `marketNotes`). Локальная пошлина складывается с государственной, факторы перемножаются.
- **`content.marketRouteMap`:** одиночный объект карты (`background`, `backgroundOpacity`, `worldWidth/Height`, `centerX/Y`, `zoom`, `nodeMode`, `kmPerPixel`, `calibration`) с защитой по `source`/`version`.
- **`content.resources`:** канонические целые `basePriceCopper` и `loadPoints` (4 pts = 1 нагрузка), `categoryTag`, `noAutoConsume`, `shelfLifeQd`, `foodEdible` (только готовые рационы), `foodType`, `id`, `label`, `unit` (немонетарная нормализуется в «ед.»), `icon`, `category`, `aliases`, `marketTags`, `useInProduction`, `useInConstruction`, `notes`. При legacy-импорте первый элемент `materialGroups` становится `categoryTag`, остальные — `marketTags`.
- **`content.buildings`:** нормализуются по контракту шаблонов (минимум `id`, `name`, `type`, `status`).
- **`content.events.general` / `external`:** `id`, `weight`, `title`, `text`, `visibility`, `effects` (`resource`, `money`, `development`, `modifier`).
- **`content.doctrines`:** `id`, `name`, `description`, `tags` (импорт в боевой каталог работает; выбор и боевое применение в массовом бою — [проект](mechanics-expansion-roadmap.md)).

## Встроенные наборы (`examples/content-packs/`)

- `skyhold-companion-example.json` — компактный учебный пример;
- `air-islands-materials-and-country-markets.json` — канонические ресурсы и характеры рынков кампании;
- `air-islands-trade-network-template.json` — сеть стран, локаций, карты, специализаций и организаций.

Связанные правила: [economy-contract.md](economy-contract.md), [external-market-contract.md](external-market-contract.md), [air-islands-trade-lore.md](air-islands-trade-lore.md).
