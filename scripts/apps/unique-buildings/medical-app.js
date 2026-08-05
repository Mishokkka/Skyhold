import { MODULE_ID } from "../../data/constants.js";
import { SkyholdUniqueBuildingApp } from "./base-app.js";

export class SkyholdMedicalBuildingApp extends SkyholdUniqueBuildingApp {}

SkyholdMedicalBuildingApp.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-unique-building", "fbl-skyhold-medical-app"],
  tag: "section",
  window: {
    title: "Лазарет",
    icon: "fa-solid fa-kit-medical",
    resizable: true
  },
  position: {
    width: 920,
    height: 650
  }
};

SkyholdMedicalBuildingApp.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/unique-buildings/medical.hbs`
  }
};

