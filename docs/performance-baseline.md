# Измерение производительности

Статус: методика, не актуальный отчёт о миллисекундах. Числа июльских/августовских аудитов относятся к их fixtures и ревизиям; см. [исторический реестр](documentation-audit-2026-11-10.md). Они не являются гарантией скорости Foundry.

## Команды и смысл

- `npm run perf` — измерения синтетических структурно валидных владений.
- `npm run perf:check` — characterization инфраструктуры измерений.
- `npm run perf:budget` — падающая проверка бюджетов; `check:all` не заменяет этот отдельный gate.
- `npm run transport:perf:check` — подготовка большой истории/сметы перевозок.

Для нового результата фиксируйте commit, Node/ОС, fixture, число запусков, p95 и конкретный сценарий. Порог берите из исполняемого benchmark, не из старой таблицы документа. Изменение порога требует причины и повторимого baseline, а не только медленного единичного запуска.

Read-cache проверяется отдельно от полной нормализации: cache-hit читает meta, не повторяет загрузку/хеширование остальных partitions. Scoped commit нормализует и пишет нужный раздел; no-op не делает world writes и не повышает revision. Локальный pan/zoom не является изменением world data.

Node не измеряет Handlebars/DOM/layout, реальные sockets, фокус и heap живой сцены. Для них нужен воспроизводимый сценарий в Foundry с runtime observer и отдельной записью среды. Отсутствие вызова функции в Node coverage не доказывает ненужность окна.


## Runtime observer

Observer выключен по умолчанию и не добавляет timing samples, пока сценарий явно не запущен. Он считает:

- `SkyholdData.get`, normalization, persist и commit;
- settings reads/writes и cache hits;
- подготовку context активной вкладки;
- render главного ApplicationV2;
- метрики active-tab context cache.

Ручной профиль в консоли Foundry:

```js
game.fblSkyhold.performance.start("player-storage", {
  foundry: game.version,
  role: game.user.isGM ? "gm" : "player"
});

// Выполнить один заранее описанный сценарий мышью.

const profile = game.fblSkyhold.performance.stop();
console.log(profile);
```

Промежуточный снимок не останавливает сценарий:

```js
game.fblSkyhold.performance.snapshot();
```

Сбросить samples и связанные storage/context-cache counters:

```js
game.fblSkyhold.performance.reset();
```

Для сравнения профилей фиксируются роль, Foundry/system version, владение, примерное число жителей/зданий/storage rows, активная вкладка и точная последовательность кликов. Один профиль не должен смешивать навигацию, tenday, импорт и бой.

## Persistence assertions

- holding-only commit: 2 meta writes + 1 holdings write, без catalog и legacy snapshot;
- catalog-only commit: 2 meta writes + 1 catalog write, без holdings и legacy snapshot;
- scoped no-op: 0 meta/partition writes, revision остаётся прежней;
- неизменённый раздел переиспользует hash из revision cache;
- dual-partition commit: rollback snapshot предыдущей revision, затем обе partitions между start/complete meta;
- single-partition interruption восстанавливается по previous/target hashes;
- смешанный dual-partition interruption использует coherent legacy rollback snapshot;
- невозможность сохранить обязательный rollback snapshot останавливает commit до start-meta.

Числа следует обновлять после существенных изменений normalizers, fixture-структуры, storage adapter или стратегии клонирования. Для сравнения важнее p95 и число settings operations, чем единичный самый быстрый запуск.
