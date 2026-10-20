# FBL Skyhold content pack format

Текущий формат: `fbl-skyhold.content-pack`, `formatVersion: 1`.

Content pack — JSON-файл для контролируемого добавления редактируемых данных мира. Импорт доступен GM через `GM → Content packs`: сначала модуль нормализует файл и показывает preview, а запись начинается только после подтверждения. Чтение JSON само по себе мир не меняет.

Ближайшее обновление зданий не является полной установкой content pack и не требует сброса ресурсов или рынка. Его отдельные границы описаны в [порядке применения v16](morale-v16-implementation.md#применение-пользователем).

## Manifest

```json
{
  "schema": "fbl-skyhold.content-pack",
  "formatVersion": 1,
  "id": "my-pack",
  "source": "author.my-pack",
  "version": 1,
  "name": "Мой набор",
  "description": "Описание набора",
  "content": {
    "buildings": [],
    "resources": [],
    "events": { "general": [], "external": [] },
    "regions": [],
    "doctrines": [],
    "marketEconomy": {
      "baseOffers": [],
      "countries": [],
      "specialties": [],
      "organizations": [],
      "sizeProfiles": [],
      "conditions": []
    }
  }
}
```

Каждый массив необязателен. Старый раздел `content.markets` больше не поддерживается: отдельные рынки-поставщики заменены слоистой экономикой. При нормализации мира старое `catalog.markets` очищается без миграции; ресурсы, регионы, маршруты, поселения и история при этом сохраняются.

## Идентичность, версии и конфликты

- `id` — стабильный id пакета;
- `source` — пространство имён автора или companion-модуля;
- `version` — положительная целая версия пакета;
- каждая импортируемая строка имеет стабильный `id` (регион может использовать `value`);
- `contentSource` и `contentVersion` строки переопределяют корневые значения;
- `add` добавляет новый id;
- `update` обновляет строку того же `source`, если входящая версия выше;
- `skip` оставляет равную или более новую установленную версию;
- `conflict` означает, что id принадлежит другому источнику; GM может явно выбрать замену.

Импорт не удаляет отсутствующие в пакете строки. Preview запоминает revision мира; устаревший preview отклоняется и должен быть рассчитан заново. Успешная запись создаёт `content-import` в operations timeline.

## Слоистая модель рынка

Итоговый ассортимент одной рыночной локации строится в фиксированном порядке:

```text
базовые предложения
  → характер государства
  → специализации конкретной локации
  → размер и текущее состояние рынка
  → доли торговых организаций и независимых торговцев
  → выбранная транспортная организация и маршрут
```

Страна не является точкой на карте. Несколько локаций могут ссылаться на один `countryId`, наследовать единый характер рынка и различаться размером, специализациями, состоянием и локальными коэффициентами.

## `content.marketEconomy.baseOffers`

Базовый ассортимент, из которого начинают все государства. Предложение может ссылаться на ресурс каталога либо на Foundry Item:

```json
{
  "id": "base-grain",
  "active": true,
  "visibility": "public",
  "sourceType": "resource",
  "resourceId": "grain",
  "kind": "resource",
  "unit": "ед.",
  "priceFactor": 1,
  "baseStock": 60,
  "volatility": 0.18,
  "ubiquity": "common",
  "forceAvailable": false,
  "tags": ["food", "bulk"],
  "priceBasis": "Оптовая партия",
  "historicalSource": "Название ряда или ссылка",
  "availabilityNotes": "Объяснение доступности"
}
```

Для `sourceType: "resource"` базовые цена и нагрузка принадлежат строке `content.resources`: предложение наследует `basePriceCopper` и `loadPoints`, а в котировке получает совместимый `load = loadPoints / 4`. Обычная региональная разница задаётся `priceFactor`; действительно особая фиксированная цена — `priceOverrideCopper`. Регион и упаковка не меняют нагрузку ресурса, поэтому целевой pack не задаёт `loadOverridePoints` для resource offer. Старые `basePriceCopper` и `load` внутри предложения при импорте пока считаются явными legacy-переопределениями для совместимости, но новые packs их не создают.

`ubiquity` принимает `essential`, `common`, `ordinary`, `specialized` или `restricted`. Размер локации определяет максимальную обычную редкость. `forceAvailable: true` обходит фильтр размера и ограничивающее правило. Предложение, добавленное страной или специализацией и отсутствующее в базе, также считается характерным и доступным принудительно.

Для `sourceType: "item"` задаются `itemUuid`, обязательные собственные `priceOverrideCopper` и `loadOverridePoints`, а `resourceId` не нужен. При заказе сохраняется независимый снимок Item.

## `content.marketEconomy.countries`

Государство описывает общий характер всех принадлежащих ему рынков:

```json
{
  "id": "novand",
  "label": "Королевство Нованд",
  "active": true,
  "visibility": "public",
  "description": "Редактируемое состояние кампании.",
  "conditionId": "ruined",
  "tradeRegime": "open",
  "taxRate": 0.05,
  "priceFactor": 1.2,
  "stockFactor": 0.5,
  "deliveryFactor": 1.5,
  "timeFactor": 1.5,
  "riskFactor": 2,
  "tags": ["recovery", "aerial"],
  "rules": [],
  "offers": []
}
```

`conditionId` ссылается на шаблон состояния. Коэффициенты страны применяются поверх него, поэтому их можно оставить равными `1`, если достаточно только состояния. `taxRate` — доля от 0 до 1. `rules` меняют базовые товары по тегам или `resourceIds`; `offers` добавляют уникальные товары страны.

## `content.marketEconomy.specialties`

Специализация — независимый модификатор локации: рыбацкий порт, кристаллическая верфь, химическая отрасль, ярмарка, военный склад и т. п. Локация может сочетать несколько специализаций.

```json
{
  "id": "fishing-port",
  "label": "Рыболовный порт",
  "category": "Промыслы",
  "description": "Много свежей и солёной рыбы; спрос на соль, снасти и бочки.",
  "active": true,
  "rules": [
    {
      "id": "fish-output",
      "label": "Местный улов",
      "active": true,
      "mode": "produce",
      "targetTags": ["fish"],
      "resourceIds": [],
      "stockFactor": 2.2,
      "priceFactor": 0.78,
      "volatilityFactor": 1.15,
      "notes": "Сезонный промысел"
    },
    {
      "id": "salt-input",
      "label": "Спрос на соль",
      "active": true,
      "mode": "consume",
      "targetTags": ["salt"],
      "stockFactor": 0.75,
      "priceFactor": 1.2,
      "volatilityFactor": 1
    }
  ],
  "offers": []
}
```

Режим правила — `adjust`, `produce`, `consume` или `restrict`. Итог определяют явные `stockFactor`, `priceFactor` и `volatilityFactor`; режим нужен также для смысла и UI. Правило совпадает, если подошёл хотя бы один `resourceId` или тег. В теги предложения входят его собственные теги, id и категория ресурса, вид товара и универсальные `materialGroups`.

Встроенный каталог содержит 115 редактируемых специализаций. Их можно отключать, изменять, удалять и дополнять без хардкода лора.

## `content.marketEconomy.organizations`

Одна организация может быть торговой, транспортной или совмещать обе роли:

```json
{
  "id": "free-trade-league",
  "label": "Свободная Торговая Лига",
  "active": true,
  "visibility": "public",
  "description": "Межгосударственная сеть.",
  "icon": "fa-solid fa-building-columns",
  "tags": ["global"],
  "merchant": {
    "enabled": true,
    "countryShares": [
      { "countryId": "novand", "sharePct": 18, "active": true }
    ],
    "includeTags": [],
    "excludeTags": ["contraband"],
    "priceFactor": 0.98,
    "priceVolatility": 0.04,
    "stockStability": 1.1
  },
  "buyer": {
    "enabled": true,
    "countryShares": [
      { "countryId": "novand", "sharePct": 20, "active": true }
    ],
    "includeTags": ["food.raw", "textile"],
    "excludeTags": ["contraband"]
  },
  "carrier": {
    "enabled": true,
    "countryShares": [
      {
        "countryId": "novand",
        "sharePct": 25,
        "modeShares": { "caravan": 5, "rail": null, "airship": 35 },
        "active": true
      }
    ],
    "modes": ["airship"],
    "priceFactor": 1.05,
    "timeFactor": 0.9,
    "riskFactor": 0.85,
    "capacityFactor": 1
  }
}
```

`merchant.countryShares` определяет личность продавца в государстве, но не делит и не клонирует общий запас рынка. `includeTags` и `excludeTags` ограничивают ассортимент организации. Нераспределённая доля принадлежит независимым торговцам; сумма выше 100% пропорционально нормализуется.

`buyer.countryShares` независимо определяет личность организации, покупающей исходящий товар поселения. Она использует общий конечный demand рынка и ресурса и не создаёт для компании отдельный спрос. `includeTags` и `excludeTags` задают допустимый ассортимент; остаток доли принадлежит независимым покупателям.

`carrier.countryShares` определяет присутствие перевозчика. `modeShares` необязательно переопределяет общую долю для каравана, железной дороги или воздушного корабля. Перевозчик предлагается только если поддерживает весь выбранный маршрут; его факторы меняют стоимость, ETA, риск и вместимость доставки. `capacityFactor: 1.5` означает на 50% больше базовой вместимости транспорта. Остаток принадлежит независимым перевозчикам.

## `content.marketEconomy.sizeProfiles` и `conditions`

Размер ограничивает редкость обычного ассортимента и меняет запас, цену и обработку:

```json
{
  "id": "town",
  "label": "Городской рынок",
  "description": "Обычный региональный центр.",
  "active": true,
  "maxUbiquity": "ordinary",
  "stockFactor": 1,
  "priceFactor": 1,
  "handlingFactor": 1
}
```

Состояние применяется к стране и, при необходимости, вторым слоем к отдельной локации:

```json
{
  "id": "blockaded",
  "label": "Блокада",
  "description": "Резкий дефицит и риск доставки.",
  "active": true,
  "priceFactor": 1.8,
  "stockFactor": 0.2,
  "deliveryFactor": 2,
  "timeFactor": 2.2,
  "riskFactor": 2.6,
  "volatilityFactor": 1.8
}
```

Глобальные параметры котировочного периода, обработки и вместимости (`marketEconomy.settings`) редактируются в GM-редакторе рынка и не являются строками общего каталога. Поля `caravanCapacityLoad`, `railCapacityLoad` и `airshipCapacityLoad` задают физическую вместимость полного рейса в абстрактных единицах груза. Значения по умолчанию — 400 для каравана, 8 000 для железнодорожного состава и 4 000 для воздушного корабля. Игровые услуги применяют к физическому пределу собственную долю: 20% для попутного груза, 10% для ускоренного и 100% для выделенного рейса; эти доли являются правилами расчёта, а не полями content pack.

## `content.regions`: рыночные локации и маршруты

Регион одновременно является контекстом событий и узлом рыночной карты:

```json
{
  "id": "novand-riud",
  "label": "Риюд — северный рынок",
  "aliases": ["Риюд"],
  "countryId": "novand",
  "marketEnabled": true,
  "marketSizeId": "city",
  "marketSpecialtyIds": ["crystal-shipyard", "air-harbor"],
  "marketConditionId": "",
  "marketTags": ["north", "shipbuilding"],
  "marketLandmassId": "novand",
  "marketAirshipOnly": true,
  "marketTransportModes": ["airship"],
  "marketLinks": [
    {
      "regionId": "novand",
      "distanceKm": 120,
      "modes": ["airship"]
    }
  ],
  "marketMapX": 720,
  "marketMapY": 180,
  "marketPriceFactor": 1,
  "marketAvailabilityFactor": 1,
  "marketDeliveryFactor": 1,
  "marketTimeFactor": 1,
  "marketRiskFactor": 1,
  "marketExportFactor": 1,
  "marketImportFactor": 1,
  "marketTaxRate": 0,
  "marketNotes": "Локальное описание."
}
```

Пустой `marketConditionId` означает наследование состояния страны. Локальная пошлина складывается с государственной, прочие коэффициенты перемножаются. Отключённая локация остаётся редактируемой и видимой на GM-карте, но не выдаёт ассортимент покупателю.

Связи задают граф маршрутов. `distanceKm` — реальная длина участка; `modes` принимает `caravan`, `rail`, `airship`. Карта также поддерживает ломаную геометрию, сезонные множители, фон, калибровку масштаба и сохранённый viewport в мировом `catalog.marketRouteMap`.

Content pack может установить карту вместе с сетью через одиночный объект `content.marketRouteMap`. Поддерживаются `background`, `backgroundOpacity`, `worldWidth`, `worldHeight`, `centerX`, `centerY`, `zoom`, `nodeMode`, `kmPerPixel` и `calibration` с двумя точками и известным расстоянием. Импорт сохраняет source/version карты, поэтому обновления не затирают карту из другого пакета без явного разрешения.

### Безопасное удаление устаревших записей

Версия пакета может объявить `content.retire`:

```json
{
  "kind": "regions",
  "id": "old-country-hub",
  "sources": ["fbl-skyhold.example-pack"]
}
```

Импорт удалит запись автоматически только при совпадении `id`, типа и `contentSource`. Запись пользователя или другого пакета становится конфликтом и требует явного выбора. Допустимы те же типы, что и для импортируемого контента, кроме одиночной карты маршрутов.

## Остальной контент

### `content.resources`

Ресурсы добавляются в пользовательский каталог и являются единственным владельцем базовой экономики товара. Обязательная целевая форма включает целочисленные `basePriceCopper` и `loadPoints` (`4` пункта = `1` единица нагрузки), а также `categoryTag`, `noAutoConsume`, `shelfLifeQd`, `foodEdible` и `foodType`. `categoryTag` — одна основная категория для правил и UI; `materialGroups` остаются множественными тегами совместимости. `foodEdible: true` ставится только подготовленным рационам, а не выводится автоматически из названия, категории или тега `edible`.

Поля `cost`, `shelfLife` и `materialGroups` можно сохранять как provenance старого набора, но расчёты используют канонические поля. При legacy-import первый `materialGroups` становится единственным `categoryTag`, а остальные сохраняются как `marketTags`. Новые рецепты сопоставляют только точный `categoryTag`; множественные `marketTags` служат ассортименту и рыночным правилам. Остальные основные поля: `id`, `label`, `unit`, `icon`, `category`, `aliases`, `marketTags`, `useInProduction`, `useInConstruction`, `notes`.

Немонетарная `unit` нормализуется в «ед.». Нагрузка известного ресурса всегда читается из целого `loadPoints`; поля `load`/`weight` складской строки и ресурсного offer её не переопределяют. У предметов Foundry остаётся собственный контракт веса.

### Чистая установка экономики

Пакет может объявить корневую политику:

```json
{
  "install": {
    "replaceMarket": true,
    "replaceResources": true,
    "overwriteResources": true
  }
}
```

`replaceMarket` добавляет в предпросмотр отдельную операцию очистки и перед установкой удаляет `catalog.marketEconomy`, старые `catalog.markets`, рыночные локации, карту и связи. `replaceResources` отдельно очищает весь `catalog.resources` перед импортом и поэтому удаляет определения пользовательских материалов, которых нет во входящем pack. `overwriteResources` без `replaceResources` только заменяет одноимённые строки и сохраняет остальные. Перед destructive install импортёр обязан требовать явное подтверждение.

Владения, складские количества, деньги, здания, жители и история не очищаются, но удаление определения ресурса может оставить складскую строку без прежнего каталожного описания. Перед `replaceResources` нужен экспорт мира.

### `content.buildings`

Шаблоны нормализуются существующим building/template contract. Минимум: `id`, `name`, `type`, `status`.

### `content.events.general` и `content.events.external`

Используют формат GM-редактора событий: `id`, `weight`, `title`, `text`, `visibility`, `effects`. Поддерживаются эффекты `resource`, `money`, `development`, `modifier`.

### `content.doctrines`

Доктрина использует `id`, `name`, `description`, `tags` и попадает в общий боевой каталог.

Каждый раздел content pack ограничен 500 строками. После импорта мировой нормализатор дополнительно защищает собственные пределы каталогов.

## Готовые наборы

- `examples/content-packs/skyhold-companion-example.json` — небольшой учебный пример;
- `examples/content-packs/air-islands-materials-and-country-markets.json` — 116 материалов, включая Animal Feed, и 16 характеров доступных государственных рынков 882 года;
- `examples/content-packs/air-islands-trade-network-template.json` — полный редактируемый шаблон с 16 странами, 69 локациями, калиброванной картой, 20 дополнительными специализациями и 22 торгово-транспортными организациями.

Все три доступны непосредственно в `GM → Content packs` и включаются в релизный ZIP. Единая нормативная экономика описана в `economy-contract.md`, фактический технический контракт текущего рынка — в `external-market-contract.md`, а происхождение лорных организаций — в `air-islands-trade-lore.md`.
