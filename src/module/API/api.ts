import { confirmAction, daeSpecialDurations } from '../../dae.js';
import { teleportToToken, blindToken, restoreVision, setTokenVisibility, setTileVisibility, moveToken, renameToken, getTokenFlag, setTokenFlag, setFlag, unsetFlag, getFlag, deleteActiveEffect, createToken, teleportToken, deleteItemActiveEffects } from '../../module/daeMacros.js';
import { convertDuration } from '../GMAction.js';
import { ActiveEffects } from '../apps/ActiveEffects.js';
import { BooleanFormulaField, DAEActiveEffectConfig, addAutoFields, otherFieldsMap, registerFieldEditor } from '../apps/DAEActiveEffectConfig.js';
import { DIMEditor } from '../apps/DIMEditor.js';
import { daeMacro, doEffects, daeSystemClass, actionQueue, actorFromUuid, doActivityEffects, DoEffectsOptions, DoEffectsTargets, localizationMap } from '../dae.js';
import { cleanActorItemsEffectOrigins, cleanEffectOrigins, fixTransferEffect, fixTransferEffects, removeActorsPassiveEffects, removeAllScenesPassiveEffects, removeCompendiaPassiveEffects, removeScenePassiveEffects, tobMapper } from '../migration.js';
import { ValidSpec, wildcardEffects } from '../Systems/DAESystem.js';
import { enumerateBaseValues } from '../dae.js';

const API = {
  supportsActivityEffectData: true,
  ActiveEffects(document: Actor.Implementation | Item.Implementation) {
    return new ActiveEffects({document});
  },
  get actionQueue() { return actionQueue },
  get allValidSpecKeys() {
    return [...otherFieldsMap.keys()].concat(Object.keys(ValidSpec.actorSpecs["union"].allSpecsObj))
  },
  DAEActiveEffectConfig(document: ActiveEffect.Implementation, options: Partial<foundry.applications.sheets.ActiveEffectConfig.Configuration> = {}) {
    return new DAEActiveEffectConfig({ document, ...options });
  },
  get DIMEditor() { return DIMEditor },
  get daeCustomEffect() {
    return daeSystemClass.daeCustomEffect;
  },
  daeSpecialDurations() {
    return daeSpecialDurations;
  },
  evalExpression(): (input: string, context: any, depth?: number) => string {
    return daeSystemClass.safeEvalExpression.bind(daeSystemClass);
  },
  get localizationMap() { return localizationMap },
  get otherValidSpecKeys() { return [...otherFieldsMap.keys()] },
  get ValidSpec() { return ValidSpec },
  get wildcardBaseEffects(): RegExp[] {
    return wildcardEffects;
  },
  actorFromUuid,
  addAutoFields,
  BooleanFormulaField,
  blindToken,
  cleanActorItemsEffectOrigins,
  cleanEffectOrigins,
  confirmAction,
  convertDuration,
  createToken,
  daeMacro,
  deleteActiveEffect,
  deleteItemActiveEffects,
  doActivityEffects,
  doEffects,
  enumerateBaseValues,
  fixTransferEffect,
  fixTransferEffects,
  getFlag,
  getTokenFlag,
  moveToken,
  removeActorsPassiveEffects,
  removeAllScenesPassiveEffects,
  registerFieldEditor,
  removeCompendiaPassiveEffects,
  removeScenePassiveEffects,
  renameToken,
  restoreVision,
  setFlag,
  setTileVisibility,
  setTokenFlag,
  setTokenVisibility,
  teleportToken,
  teleportToToken,
  tobMapper,
  unsetFlag,
};

export default API;
