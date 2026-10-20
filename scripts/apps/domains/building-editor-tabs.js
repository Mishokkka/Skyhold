// Presentation shared by the live editor and its inert comparison samples.
export const BUILDING_EDITOR_TABS = [
  { id: "main", label: "Основное", shortLabel: "ОСН.", icon: "fa-solid fa-sliders" },
  { id: "workers", label: "Работники", shortLabel: "РАБ.", icon: "fa-solid fa-users-gear" },
  { id: "construction", label: "Строительство", shortLabel: "СТРОЙ.", icon: "fa-solid fa-hammer" },
  { id: "projects", label: "Проекты", shortLabel: "ПРОЕКТ.", icon: "fa-solid fa-diagram-project" },
  { id: "production", label: "Производство", shortLabel: "ПРОИЗВ.", icon: "fa-solid fa-industry" },
  { id: "agriculture", label: "Участок", shortLabel: "УЧАСТ.", icon: "fa-solid fa-seedling" },
  { id: "livestock", label: "Стадо", shortLabel: "СТАДО", icon: "fa-solid fa-cow" },
  { id: "income", label: "Доходность", shortLabel: "ДОХОД", icon: "fa-solid fa-coins" },
  { id: "defense", label: "Оборона", shortLabel: "ОБОР.", icon: "fa-solid fa-shield-halved" },
  { id: "housing", label: "Жилое", shortLabel: "ЖИЛЬЁ", icon: "fa-solid fa-house" },
  { id: "storage", label: "Складское", shortLabel: "СКЛАД", icon: "fa-solid fa-box-archive" },
  { id: "culture", label: "Культура/Религия", shortLabel: "КУЛЬТ./РЕЛ.", icon: "fa-solid fa-music" }
];

export function buildingEditorTab(id) {
  return { ...BUILDING_EDITOR_TABS.find(tab => tab.id === id) };
}
