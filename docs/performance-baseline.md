# Производительность: методика и бюджеты

Методика офлайн-замеров и профилирования в Foundry. Актуальные пороги заданы непосредственно в исполняемых скриптах, а не в исторических таблицах.

## Команды

- `npm run perf` — прогон синтетических владений (medium/large/extreme: 100/500/1000 жителей).
- `npm run perf:budget` — строгий gate бюджетов (`check:all` его не заменяет).
- `npm run perf:check` — characterization самого observer.
- `npm run transport:perf:check` — подготовка большой истории/сметы перевозок.

При сравнении фиксируйте commit, Node/ОС, fixture, p95 и число settings-операций. Node не измеряет Handlebars/DOM/layout, реальные sockets и heap браузера — для них нужен runtime observer в Foundry.

## Runtime observer (консоль Foundry)

По умолчанию выключен и не вносит overhead. Собирает метрики `SkyholdData.get`, нормализации, persist/commit, settings reads/writes и cache hits, подготовки контекста активной вкладки, render главного ApplicationV2 и context-cache.

```js
game.fblSkyhold.performance.start("player-storage", {
  foundry: game.version,
  role: game.user.isGM ? "gm" : "player"
});
// Выполнить один конкретный сценарий мышью.
console.log(game.fblSkyhold.performance.stop());
// Промежуточный снимок: game.fblSkyhold.performance.snapshot();
// Сброс счётчиков:      game.fblSkyhold.performance.reset();
```

Для сопоставимости фиксируйте роль, версии Foundry/системы, размер владения, вкладку и последовательность кликов; не смешивайте разные рабочие процессы в одном профиле.

## Контракты persistence

- **holding-only commit:** 2 записи meta + 1 запись holdings (без catalog и legacy snapshot).
- **catalog-only commit:** 2 записи meta + 1 запись catalog (без holdings и legacy snapshot).
- **scoped no-op:** 0 записей, ревизия не растёт; read-cache hit читает только meta; неизменённый раздел переиспользует hash из revision cache; локальный pan/zoom мир не пишет.
- **dual-partition commit:** сначала rollback snapshot предыдущей ревизии (его сбой останавливает commit до start-meta), затем обе partitions между start/complete meta.
- **Восстановление:** прерванная запись одной partition восстанавливается по previous/target hashes; смешанная dual-partition — по согласованному legacy rollback snapshot.
