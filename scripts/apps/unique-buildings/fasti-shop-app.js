import { MODULE_ID } from "../../data/constants.js";
import { SkyholdUniqueBuildingApp } from "./base-app.js";

export class SkyholdFastiShopApp extends SkyholdUniqueBuildingApp {
  async _onRender(context, options) {
    await super._onRender(context, options);
    const image = this.element?.querySelector?.(".fbls-fasti-splash-image");
    if (!image) return;
    const fit = () => this._fitWindowToSplashImage(image);
    if (image.complete && image.naturalWidth && image.naturalHeight) fit();
    else image.addEventListener("load", fit, { once: true });
  }

  _fitWindowToSplashImage(image) {
    const src = String(image?.currentSrc || image?.src || "");
    const naturalWidth = Number(image?.naturalWidth ?? 0);
    const naturalHeight = Number(image?.naturalHeight ?? 0);
    if (!src || naturalWidth <= 0 || naturalHeight <= 0) return;
    if (this._lastFastiFitSrc === src) return;
    this._lastFastiFitSrc = src;

    const ratio = Math.max(0.55, Math.min(1.8, naturalWidth / naturalHeight));
    const viewportWidth = Math.max(640, Number(globalThis.innerWidth ?? globalThis.screen?.availWidth ?? 1280));
    const viewportHeight = Math.max(520, Number(globalThis.innerHeight ?? globalThis.screen?.availHeight ?? 800));
    const maxWidth = Math.min(1120, Math.floor(viewportWidth * 0.84));
    const maxHeight = Math.min(860, Math.floor(viewportHeight * 0.84));
    const minWidth = Math.min(620, maxWidth);
    const minHeight = Math.min(520, maxHeight);
    const chromeHeight = 112;

    let contentWidth = maxWidth;
    let contentHeight = Math.round(contentWidth / ratio) + chromeHeight;
    if (contentHeight > maxHeight) {
      contentHeight = maxHeight;
      contentWidth = Math.round((contentHeight - chromeHeight) * ratio);
    }
    contentWidth = Math.max(minWidth, Math.min(maxWidth, contentWidth));
    contentHeight = Math.max(minHeight, Math.min(maxHeight, contentHeight));

    this.setPosition?.({
      width: contentWidth,
      height: contentHeight,
      left: Math.max(20, Math.round((viewportWidth - contentWidth) / 2)),
      top: Math.max(20, Math.round((viewportHeight - contentHeight) / 2))
    });
  }
}

SkyholdFastiShopApp.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-unique-building", "fbl-skyhold-fasti-shop-app"],
  tag: "section",
  window: {
    title: "Лавка редкостей Фасти ди Ото",
    icon: "fa-solid fa-book-sparkles",
    resizable: true
  },
  position: {
    width: 860,
    height: 640
  }
};

SkyholdFastiShopApp.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/unique-buildings/fasti-shop.hbs`
  }
};
