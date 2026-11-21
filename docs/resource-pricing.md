# Товарная единица и калибровка цен

Принятые игровые абстракции. Актуальные ID, цены, нагрузка и сроки находятся только в [генерируемом каталоге ресурсов v5](economy-resource-catalog.md).

## Смысл цены и единицы

- `basePriceCopper` — нейтральная оптовая цена до доставки, страховки, пошлин, региональных коэффициентов и способности продавца. Игровые ММ не переводятся напрямую в исторические фунты или килограммы; зарплата выплачивается поверх отдельного жилья и питания.
- `ЕД.` — целая товарная партия, рацион, ёмкость, кипа, комплект или ящик; у разных товаров физическая масса различается. Грузовые `loadPoints` (4 pts = 1 нагрузка) — отдельная игровая мера, не тонны.

## Принятые значения по группам

- **Пища:** готовая ЕД. — дневная порция обычного рациона; сырьё требует рецепта; срок полуфабриката отличается от готового блюда.
- **Алкоголь:** мерная торговая ёмкость заданного семейства, качества и крепости (разные выходы перегонки).
- **Вооружение и медицина:** комплекты своего масштаба (не единичный патрон); медицинские припасы и лекарства имеют разные роли.
- **Вода:** включает подготовку, тару и доставку; собственный колодец сам по себе не продаёт воду.
- **Отдельные ресурсы:** `light-alloys` — простые сплавы (не обещание малого веса); `parchment` — письменные материалы; `silk` — готовая ткань; `money` в строительстве — монеты (не сырьевое золото); 4 кристаллических ресурса независимы и сами по себе не включают судостроение или фабрику ядра.
- **Теги:** `categoryTag` задаёт взаимозаменяемость в рецептах, `marketTags` — рыночную классификацию. Поголовье животных ведётся отдельно; авторская настройка мира приоритетнее исторической аналогии.

## Правила следующей калибровки

- Сравнивайте маржу, оплату труда, содержание, время/вместимость выдержки, логистику, конечный спрос и оборотный капитал в последовательных сценариях (`economy:scenarios:check`), а не по отдельным рецептам. Сохранённые договоры после правки прайса не пересчитываются.

## Исторические ориентиры (середина XIX века)

Сохранённая библиография авторских ориентиров (не текущие правила и не проверенные факты):

- [Hansard, Agricultural Distress, 1851](https://api.parliament.uk/historic-hansard/commons/1851/feb/11/agricultural-distress) · [Acreage of Wheat, Barley, etc., 1904](https://api.parliament.uk/historic-hansard/commons/1904/may/09/acreage-of-wheat-barley-etc) · [Navigation Bill, 1849](https://api.parliament.uk/historic-hansard/commons/1849/mar/12/navigation-bill-adjourned-debate)
- [Hansard, Civil Service Estimates, 1859](https://api.parliament.uk/historic-hansard/commons/1859/aug/04/supply-civil-service-estimates-1) · [Pirates Head Money Repeal Bill, 1850](https://api.parliament.uk/historic-hansard/lords/1850/apr/18/pirates-head-money-repeal-bill) · [Wood Used in Ship-Building, 1850](https://api.parliament.uk/historic-hansard/commons/1850/mar/05/wood-used-in-ship-building)
- [Hansard, Import Duties, 1853](https://api.parliament.uk/historic-hansard/commons/1853/mar/03/import-duties) · [Financial Statement, 1853](https://api.parliament.uk/historic-hansard/commons/1853/apr/28/financial-statement-the-budget) · [Tea and Sugar Duties, 1857](https://api.parliament.uk/historic-hansard/commons/1857/aug/12/ways-and-means-the-tea-and-sugar-duties)
- [Hansard, Enfield Rifles, 1860](https://api.parliament.uk/historic-hansard/commons/1860/aug/03/the-enfield-rifles-question) · [Army Estimates, 1860](https://api.parliament.uk/historic-hansard/commons/1860/jun/18/supply-army-estimates) · [Bimetallism, 1890](https://api.parliament.uk/historic-hansard/commons/1890/apr/18/bi-metallism)
- [Science Museum (Bessemer)](https://blog.sciencemuseum.org.uk/onward-ever-sir-henry-bessemer-frs-19-1-1813-15-3-1898/) · [RSC (Aluminium)](https://periodic-table.rsc.org/element/13/aluminium) · [Royal Museums Greenwich (Cutty Sark)](https://www.rmg.co.uk/sites/default/files/Cutty_Sark_Facts_Pack.pdf)
