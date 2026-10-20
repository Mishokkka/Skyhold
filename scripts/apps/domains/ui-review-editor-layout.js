import { prepareBuildingEditorLayout } from "./building-editor-layout.js";

export function prepareEditorReviewLayouts(root) {
  for (const sample of root.querySelectorAll("[data-review-editor-after]")) {
    prepareBuildingEditorLayout(sample, { tab: sample.dataset.reviewEditorAfter, navigation: sample.dataset.reviewEditorAfter === "navigation" });
    for (const section of sample.querySelectorAll("details[data-fbls-disclosure]")) section.dataset.reviewDisclosureKey = section.dataset.fblsDisclosure;
  }
}
