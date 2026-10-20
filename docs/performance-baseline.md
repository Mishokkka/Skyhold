# FBL Skyhold: performance baseline

Дата замера: 15 июля 2026. Среда: Node.js v24.16.0, Windows x64.

Запуск:

```bash
npm run perf
npm run perf:budget
npm run perf:check
```

`perf:budget` запускает тот же benchmark как падающий release gate. Бюджеты намеренно содержат запас для менее быстрых CI-машин, но защищают clone, normalization, hash, cache-hit, минимальное ускорение и отсутствие повторной нормализации на cache-hit. Менять их следует только вместе с новым подтверждённым baseline, а не для сокрытия регрессии.

| Fixture | Clone p95 max | Normalize p95 max | Hash p95 max | Cache-hit p95 max | Min speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| medium | 35 ms | 450 ms | 35 ms | 25 ms | 4x |
| large | 55 ms | 900 ms | 75 ms | 60 ms | 4x |
| extreme | 60 ms | 1300 ms | 100 ms | 55 ms | 4x |

Harness использует синтетические, но структурно валидные поселения. Он отдельно измеряет глубокое клонирование, полную нормализацию, hashing holdings, прежний read-cache путь и новый revision-first cache-hit. «Старый путь» воспроизводит чтение и клонирование четырёх settings, default/legacy/commit hashing и возврат уже нормализованного cache; лишняя нормализация ему не приписывается.

| Fixture | Жители | Здания | Storage rows | Log rows | Старый read p95 | Cache-hit p95 | Ускорение |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| medium | 100 | 50 | 100 | 250 | 75.37 ms | 13.00 ms | 5.8x |
| large | 500 | 200 | 500 | 500 | 164.43 ms | 20.20 ms | 8.1x |
| extreme | 1000 | 200 | 1000 | 1000 | 230.11 ms | 22.52 ms | 10.2x |

Дополнительные p95 для extreme fixture:

- глубокий clone: 21.65 ms;
- полная normalization: 732.32 ms;
- holdings hash: 38.15 ms.

Это dev-characterization, а не обещание одинакового времени на всех машинах. Устойчивый результат здесь — структура работы: cache-hit делает ровно одно чтение meta, не читает holdings/catalog/legacy, не хеширует partitions и не запускает normalization.

Рост времени полной normalization относительно прежнего baseline считается сигналом холодного пути, а не регрессией cache-hit. Оптимизировать его следует только по живому профилю конкретного мира: fixture и число нормализуемых доменов теперь больше.

Приведённые замеры являются историческими baseline, не текущей гарантией скорости. Актуальные значения получают повторным запуском указанных команд; UI и сетевые задержки проверяются отдельно.

## Scoped write baseline (16 июля 2026)

Benchmark теперь измеряет полный путь записи: cache-hit draft, partition normalization, split-storage hashing, start/complete meta и запись изменённого раздела. Для `holdings` и `catalog` ожидаются ровно три world settings write на commit; логический no-op обязан завершаться без world writes и без увеличения revision.

| Fixture | Holdings write p95 | Catalog write p95 | No-op p95 | No-op world writes |
| --- | ---: | ---: | ---: | ---: |
| medium | 163.19 ms | 164.88 ms | 151.18 ms | 0 |
| large | 706.46 ms | 187.77 ms | 590.25 ms | 0 |
| extreme | 1022.44 ms | 196.99 ms | 980.73 ms | 0 |

Падающие бюджеты оставляют запас для CI: `350/300/300 ms` для medium, `900/400/850 ms` для large и `1400/350/1300 ms` для extreme (`holdings/catalog/no-op`). При scoped commit неизменённый раздел не клонируется и не хешируется повторно; готовые hashes передаются в обе фазы commit meta.

Viewport карты маршрутов не входит в world write benchmark: pan/zoom — локальное клиентское состояние. Открытие и закрытие карты без изменения viewport не выполняет даже client-setting write.

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
