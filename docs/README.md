# Документация Skyhold

Навигация по действующим правилам, проектам и проверкам модуля. Вход для пользователей — [README.md](../README.md); правила разработки и границы аудита — [AGENTS.md](../AGENTS.md); карта исходников и API — [scripts/README.md](../scripts/README.md); владельцы CSS и UI-компоненты — [styles/README.md](../styles/README.md).

Наличие правила в справке или прохождение офлайн-проверок не означает автоматическое применение миграций к сохранённому миру и не заменяет ручную проверку в Foundry.

## Действующие справочники

| Область | Документы |
|---|---|
| Хозяйство и десятник | [Экономика](economy-contract.md), [окно десятника](tenday-window-contract.md) |
| Люди и труд | [Труд, штат, типажи и планировщик](labor-contract.md) |
| Здания и службы | [Каталог зданий v19](building-catalog.md), [довольство, Репутация и службы](building-social-contract.md) |
| Производство | [Партии, частичная загрузка и ожидание](production-contract.md) |
| Ресурсы и цены | [Каталог ресурсов v5](economy-resource-catalog.md), [единицы и калибровка](resource-pricing.md) |
| Рынок и маршруты | [Внешний рынок и параллельные маршруты](external-market-contract.md) |
| Перевозки | [Перевозки v2/v3: маршрутизация, тарифы, груз и десятник](transport-contract.md) |
| Флот | [Корабли: управление, экипаж, договоры и отчёт](ships-world-stage.md) |
| Банки и Политика | [Банки](banking.md), [Политика v1](politics-v1-contract.md) |
| Обновление и расширение | [Переходы и восстановление](migrations.md), [формат content pack](content-pack-format.md), [API уникальных зданий](unique-buildings-api.md) |
| Кампания | [Экипаж «Магнифика»](magnifique-crew-import.md), [торговый лор Воздушных Островов](air-islands-trade-lore.md) |

Каталоги зданий и ресурсов генерируются из кода (`scripts/dev/build-building-catalog-reference.mjs` и `build-resource-catalog-reference.mjs`); `npm run docs:check` сверяет ссылки, якоря, оба каталога и достижимость дерева без записи. Маршрут открытия конкретного здания: `node scripts/dev/building-development-reachability-check.mjs --route <id>`.

## Проекты — отдельно от реализации

| Документ | Назначение |
|---|---|
| [Реестр будущих механик](mechanics-expansion-roadmap.md) | P01–P27, отложенные решения труда, корабли/карта и публичный viewer |
| [Регулярные приезжие](newcomer-arrival-proposal.md) | Не подключено к runtime; таблица ожиданий сверяется тестом, шанс требует калибровки |

## Проверки и методика

| Документ | Роль |
|---|---|
| [Общая Foundry-матрица](manual-foundry-smoke-matrix.md) | Базовый ручной чеклист ГМа и игрока и журнал прогонов |
| [Перевозки](transport-v2-validation.md), [корабли](ships-manual-smoke.md), [карта и регионы](route-network-smoke.md) | Профильные ручные чеклисты |
| [Производительность](performance-baseline.md) | Команды benchmark, runtime observer и контракты persistence |

## Архив в истории Git

Удалённые при ревизии документации отчёты и исторические таблицы доступны на ревизии `98df194` (последний коммит до очистки; см. также PR #14 и PR #15):

| Архивные материалы (`98df194`) | Куда перенесены действующие правила и проверки |
|---|---|
| Аудиты PR #14–#15 (`documentation-audit-2026-11-10.md`, `independent-audit-2026-11-10.md`, `final-audit-2026-11-11.md`, `pr15-independent-audit-2026-11-12.md`) | [Общая матрица](manual-foundry-smoke-matrix.md) и регрессионные проверки `scripts/dev/` |
| Утверждённый баланс и дерево v14/v15 (`building-development-approved.md`, `building-development-tree-proposal.md`, `building-preparation-revision-2026-09-05.md`) | [Каталог зданий v19](building-catalog.md), фикстура `scripts/dev/fixtures/building-approved-development.mjs` и `npm run development:check` |
| Нормы ТО и кадров v15 (`building-maintenance-proposal.md`, `building-worker-affinity-proposal.md`) | [Труд и штат](labor-contract.md), [экономика](economy-contract.md), `building-development-reachability-check.mjs` и `npm run development:workers:check` |
| Дамп маршрутов (`building-development-reachability.md`) | Проверка и отчёт по запросу: `node scripts/dev/building-development-reachability-check.mjs --route <id>` |
| Разрозненные транспортные, рыночные и viewer-планы (`transport-*.md`, `parallel-market-routes-contract.md`, `public-viewer-implementation-plan.md`) | [Перевозки](transport-contract.md), [внешний рынок](external-market-contract.md), [карта и регионы](route-network-smoke.md), [реестр механик](mechanics-expansion-roadmap.md) |
