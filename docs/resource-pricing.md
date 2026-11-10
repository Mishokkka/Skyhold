# Товарная единица и калибровка цен

Статус: принятые игровые абстракции. Текущие цены, названия, нагрузка, срок и примечания каждой записи находятся только в [генерируемом каталоге ресурсов](economy-resource-catalog.md). Исходные цены v2/v3 не являются текущим прайсом v5.

## Что означает цена

`basePriceCopper` — нейтральная оптовая цена до доставки, страховки, пошлин, региональных факторов и способности продавца. Игровые ММ не пересчитываются напрямую в исторические фунты или массу. Зарплата выплачивается поверх отдельно предоставляемого жилья и обычного питания; ставка конкретной работы может отличаться от базового ориентира.

ЕД. — целая товарная партия, рацион, ёмкость, кипа, комплект или ящик. У разных товаров она не означает одинаковые килограммы и объём. Грузовые points — самостоятельная игровая мера. Не подменяйте ими тонны и не увеличивайте выпуск, выводя физическую массу из цены.

## Принятые значения смысла

- Готовая пищевая единица — дневная порция обычного рациона; сырьё требует рецепта. Срок обработки полуфабриката отличается от срока готового продукта.
- Алкогольная единица — мерная торговая ёмкость заданного семейства, качества и крепости. Разные крепости имеют разные выходы перегонки.
- Оружие и военные припасы — комплекты своего масштаба, а не единичная монета/патрон; см. примечание конкретного ресурса. Медицинские припасы и лекарства имеют разные назначения.
- Вода включает подготовку, тару и доставку; собственный колодец не означает продажу права доступа к воде.
- `light-alloys` — простые сплавы, не обещание малого веса; `parchment` — письменные материалы; `silk` — готовая ткань.
- `money` в строительстве — деньги. Историческое слово Gold в рецепте может означать монеты и не должно автоматически становиться сырьевым золотом.
- Четыре кристаллических ресурса независимы. Их наличие не включает новые рецепты, судостроение или фабрику ядра; такие функции требуют собственного проекта.
- `categoryTag` означает взаимозаменяемость рецепта, `marketTags` — рыночную классификацию. «Строительный» товар не обязательно заменяет камень.

Цены животных и поголовье ведутся отдельно от складских ресурсов. Лорная редкость, каноническая цена и реализованная доступность — разные сведения. Авторская настройка мира приоритетна над исторической аналогией.

## Как проверять следующую калибровку

Сравнивайте материальную маржу, оплату труда, содержание, время/вместимость выдержки, доставку, конечный спрос и оборотный капитал. Нулевой выпуск услуги не делает её бесполезной; военное/бытовое самообеспечение не равно денежной продаже. Сохранённые договоры не пересчитываются после правки прайса.

Баланс всего поселения подтверждается последовательным сценарием с полным составом инфраструктуры, а не суммой выгодных рецептов. [Отчёт PR #14](independent-audit-2026-11-10.md) фиксирует границы конкретных опытов. Текущий справочник не утверждает историческую точность экономики.

## Исторические источники калибровки

Эти ссылки сохранены из исходного исследования как происхождение авторских ориентиров середины XIX века. В документальном аудите они заново не исследовались; их числа не представлены как актуальные правила или независимо подтверждённые исторические факты.


- [Hansard, Agricultural Distress, 1851](https://api.parliament.uk/historic-hansard/commons/1851/feb/11/agricultural-distress)
- [Hansard, Acreage of Wheat, Barley, etc., 1904](https://api.parliament.uk/historic-hansard/commons/1904/may/09/acreage-of-wheat-barley-etc)
- [Hansard, Navigation Bill, 1849](https://api.parliament.uk/historic-hansard/commons/1849/mar/12/navigation-bill-adjourned-debate)
- [Hansard, Civil Service Estimates, 1859](https://api.parliament.uk/historic-hansard/commons/1859/aug/04/supply-civil-service-estimates-1)
- [Hansard, Pirates Head Money Repeal Bill, 1850](https://api.parliament.uk/historic-hansard/lords/1850/apr/18/pirates-head-money-repeal-bill)
- [Hansard, Wood Used in Ship-Building, 1850](https://api.parliament.uk/historic-hansard/commons/1850/mar/05/wood-used-in-ship-building)
- [Hansard, Import Duties, 1853](https://api.parliament.uk/historic-hansard/commons/1853/mar/03/import-duties)
- [Hansard, Financial Statement, 1853](https://api.parliament.uk/historic-hansard/commons/1853/apr/28/financial-statement-the-budget)
- [Hansard, Tea and Sugar Duties, 1857](https://api.parliament.uk/historic-hansard/commons/1857/aug/12/ways-and-means-the-tea-and-sugar-duties)
- [Hansard, Enfield Rifles, 1860](https://api.parliament.uk/historic-hansard/commons/1860/aug/03/the-enfield-rifles-question)
- [Hansard, Army Estimates, 1860](https://api.parliament.uk/historic-hansard/commons/1860/jun/18/supply-army-estimates)
- [Science Museum](https://blog.sciencemuseum.org.uk/onward-ever-sir-henry-bessemer-frs-19-1-1813-15-3-1898/)
- [Royal Society of Chemistry](https://periodic-table.rsc.org/element/13/aluminium)
- [Hansard, Bimetallism, 1890](https://api.parliament.uk/historic-hansard/commons/1890/apr/18/bi-metallism)
- [Royal Museums Greenwich, Cutty Sark facts](https://www.rmg.co.uk/sites/default/files/Cutty_Sark_Facts_Pack.pdf)
