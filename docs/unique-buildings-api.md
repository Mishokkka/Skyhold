# Unique building apps

Статус: реализовано. Это справка по действующему extension contract, а не план будущей работы.

Skyhold buildings may declare `building.special.kind`. When a kind is registered,
clicking that building opens the registered ApplicationV2 instead of the standard
building editor.

```js
game.fblSkyhold.uniqueBuildings.register("example-kind", {
  appClass: ExampleBuildingApp,
  label: "Example building",
  source: "my-module"
});
```

The record is still a normal building: it appears in the manager, can be dragged
to scenes, participates in construction, and keeps shared fields such as name,
image, status, notes, workers, and storage data when the app uses them.

For spoiler-safe campaign content, add the unique building to the template
catalog with `visibility: "gm"`. Hidden templates are visible to the GM in the
template browser's hidden section, are unavailable to players, and create hidden
building instances when used by the GM.

Unique building apps may replace the primary body, but should keep access to
shared building editing tabs such as `Основное` and `Строительство` when the
building needs normal management.

Built-in kinds:

- `medical` — dedicated lazaret window.
- `fasti-shop` — Laputa campaign shop with treasury contributions.

Unknown kinds fall back to the standard editor.

## Architectural contract

- discriminator: `building.special.kind`;
- уникальные данные живут в `building.special.data`, если поле не принадлежит общей подсистеме вроде `building.medical`;
- регистрация доступна через `game.fblSkyhold.uniqueBuildings`;
- приложения используют обычные Skyhold transactions и holding permissions;
- spoiler-контент начинается с catalog template `visibility: "gm"`; созданный из него экземпляр наследует GM-only visibility;
- уникальное окно сохраняет общие вкладки управления зданием, как минимум `Основное` и `Строительство`;
- неизвестный или недоступный kind всегда открывается стандартным редактором.

## Built-in implementations

- `medical` — эталонное уникальное приложение лазарета с общей medical/mass-combat интеграцией;
- `fasti-shop` — скрытый campaign template с атомарными взносами из казны, историей операций и порогом открытия `3999.9 GP`.

Оба built-in вида используют тот же публичный registry contract, который доступен companion-модулям.
