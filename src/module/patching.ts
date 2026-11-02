import { libWrapper, replaceFormulaData } from "./dae.js";
import { log } from "../dae.js";

export function patchingInitSetup() {
  return;
}

export function initPatching() {
  log("Patching Roll.replaceFormulaData");
  libWrapper.register("dae", "Roll.replaceFormulaData", replaceFormulaData, "MIXED");
}

export function setupPatching() {
  log("Patching ActiveEffect.isTemporary");
  libWrapper.register("dae", "CONFIG.ActiveEffect.documentClass.prototype.isTemporary", isTemporary, "WRAPPER");
  log("Patching ActiveEffect.isConcealed");
  libWrapper.register("dae", "CONFIG.ActiveEffect.documentClass.prototype.isConcealed", isConcealed, "WRAPPER");
};
function isTemporary(this: ActiveEffect.Implementation, wrapped) {
  // if (this.parent instanceof CONFIG.Actor.documentClass && this.data.flags?.dae?.transfer) return false;
  this._prepareDuration();
  return wrapped() || this.flags?.dae?.showIcon === "always" || this.flags?.dae?.showIcon === true; // workaround for migration purposes
}
function isConcealed(this: ActiveEffect.Implementation, wrapped) {
  return wrapped() || this.flags?.dae?.showIcon === "never";
}
