import { ceInterface, atlActive, daeSystemClass, localizationMap } from "../dae.js";
import { i18n, daeSpecialDurations, daeMacroRepeats, error } from "../../dae.js";
import { ValidSpec } from "../Systems/DAESystem.js";
import { DAEFieldBrowser } from "./FieldBrowser.js";

/**
 * A DataField for boolean formula strings that combine with || (OR) and && (AND) semantics
 * via Active Effect change modes, analogous to dnd5e's FormulaField for arithmetic formulas.
 */
export class BooleanFormulaField extends foundry.data.fields.StringField {
  _castChangeDelta(delta: string) {
    return (this._cast(delta) ?? "").trim();
  }

  // ADD → OR semantics: either condition grants the flag
  _applyChangeAdd(value: string, delta: string, model: any, change: any) {
    if (!value) return delta;
    return `(${value}) || (${delta})`;
  }

  // MULTIPLY → AND semantics: all conditions must be met
  _applyChangeMultiply(value: string, delta: string, model: any, change: any) {
    if (!value) return value;
    return `(${value}) && (${delta})`;
  }

  // UPGRADE → OR (same as ADD for booleans)
  _applyChangeUpgrade(value: string, delta: string, model: any, change: any) {
    return this._applyChangeAdd(value, delta, model, change);
  }

  // DOWNGRADE → AND (same as MULTIPLY for booleans)
  _applyChangeDowngrade(value: string, delta: string, model: any, change: any) {
    return this._applyChangeMultiply(value, delta, model, change);
  }
}

export type AutoFieldEntry = { name: string, type?: import("../Systems/DAESystem.js").FieldType };
export const otherFieldsMap: Map<string, AutoFieldEntry> = new Map();

export function addAutoFields(fields: (string | AutoFieldEntry)[]) {
  for (const field of fields) {
    const entry = typeof field === "string" ? { name: field } : field;
    if (!entry.name) continue;
    const existing = otherFieldsMap.get(entry.name);
    if (existing) {
      // Update type if a new type is provided for an existing entry
      if (entry.type !== undefined) existing.type = entry.type;
      continue;
    }
    otherFieldsMap.set(entry.name, entry);
  }
}

// --- Pluggable field editor registry ---

export interface FieldEditorContext {
  /** The full change key */
  key: string;
  /** The effect being edited */
  effect: ActiveEffect;
  /** The effect's parent document (Actor, Item, etc.) */
  parent: Actor | Item | null;
  /** Index in the changes array */
  changeIndex: number;
  /** The DAEActiveEffectConfig app instance */
  app: DAEActiveEffectConfig;
}

export interface FieldEditorRegistration {
  /** Exact key or prefix ending with "." to match (e.g. "flags.midi-qol.OverTime") */
  keyMatch: string;
  /**
   * Called when the user clicks the edit button.
   * Receives current value string + context, returns updated value or null to cancel.
   */
  editor: (currentValue: string, context: FieldEditorContext) => Promise<string | null>;
  /** Optional icon class (default: "fas fa-edit") */
  icon?: string;
  /** Optional tooltip text */
  tooltip?: string;
}

const fieldEditorRegistry: Map<string, FieldEditorRegistration> = new Map();

export function registerFieldEditor(registration: FieldEditorRegistration): void {
  fieldEditorRegistry.set(registration.keyMatch, registration);
}

export function getFieldEditor(key: string): FieldEditorRegistration | undefined {
  // Exact match first
  if (fieldEditorRegistry.has(key)) return fieldEditorRegistry.get(key);
  // Then prefix match — walk up the key segments
  const parts = key.split(".");
  while (parts.length > 1) {
    parts.pop();
    const prefix = parts.join(".") + ".";
    if (fieldEditorRegistry.has(prefix)) return fieldEditorRegistry.get(prefix);
  }
  return undefined;
}

const stackableOptions = {
  noneName: "dae.StackableOptions.noneName",
  noneNameOnly: "dae.StackableOptions.noneNameOnly",
  none: "dae.StackableOptions.none",
  multi: "dae.StackableOptions.multi",
  count: "dae.StackableOptions.count",
  countDeleteDecrement: "dae.StackableOptions.countDeleteDecrement"
}

export class DAEActiveEffectConfig extends foundry.applications.sheets.ActiveEffectConfig {
  declare tokenMagicEffects: Record<string, string>;
  declare statusEffectList: Record<string, string>;
  declare ATLPresets?: Record<string, string>;
  declare ATLVisionModes?: Record<string, string>;
  declare validFields: Record<string, {name: string, description?: string}>;
  declare validSpecsToUse: {
    allSpecs: ValidSpec[];
    allSpecsObj: Record<string, ValidSpec>;
    baseSpecs: ValidSpec[];
    baseSpecsObj: Record<string, ValidSpec>;
    derivedSpecs: ValidSpec[],
    derivedSpecsObj: Record<string, ValidSpec>;
  };
  declare daeFieldBrowser: DAEFieldBrowser;
  ceEffectList: Record<string, string> = {};

  constructor(options: Partial<foundry.applications.sheets.ActiveEffectConfig.Configuration>) {
    // @ts-expect-error v13 stubby
    super(options);
    this.tokenMagicEffects = {};
    if (globalThis.TokenMagic?.getPresets) {
      globalThis.TokenMagic.getPresets().forEach(preset => {
        this.tokenMagicEffects[preset.name] = preset.name;
      })
    } else this.tokenMagicEffects["invalid"] = "module not active"

    this.validSpecsToUse = ValidSpec.actorSpecs?.["union"];
    if (!this.validSpecsToUse) {
      ui.notifications?.error("DAE | No valid specs found");
      return;
    }
    daeSystemClass.configureLists()

    this.statusEffectList = {};
    CONFIG.statusEffects
      .filter(se => se.id)
      .map(se => ({ id: se.id, name: i18n(se.name) }))
      .toSorted((a, b) => a.name < b.name ? -1 : 1)
      .forEach(se => {
        this.statusEffectList[se.id] = se.name;
      });

    if (ceInterface) {
      ceInterface.findEffects().forEach(ceEffect => { this.ceEffectList[ceEffect.name] = ceEffect.name; });
    }

    if (atlActive && !isEnchantment(options.document!)) {
      this.ATLPresets = {};
      game.settings.get("ATL", "presets").forEach(preset => this.ATLPresets![preset.name] = preset.name);

      Object.keys(CONFIG.Canvas.detectionModes).forEach(dm => {
        const name = `ATL.detectionModes.${dm}.range`;
        if (!otherFieldsMap.has(name)) {
          otherFieldsMap.set(name, { name });
        }
      });

      this.ATLVisionModes = {};
      Object.values(CONFIG.Canvas.visionModes)
        .filter(f => f.tokenConfig)
        .forEach(f => this.ATLVisionModes![f.id!] = i18n(f.label!))
    }

    this.validFields = { "__": { name: "" } }
    this.validFields = this.validSpecsToUse.allSpecs
      .filter(e => e._fieldSpec.includes(""))
      .reduce((mods, em) => {
        mods[em._fieldSpec] = {
          name: localizationMap[em._fieldSpec]?.name ?? em._label,
          description: localizationMap[em._fieldSpec]?.description ?? em._description
        };
        return mods;
      }, this.validFields);
    if (!isEnchantment(this.document)) {
      for (let fieldName of [...otherFieldsMap.keys()].sort((a, b) => a.toLocaleLowerCase() < b.toLocaleLowerCase() ? -1 : 1)) {
        this.validFields[fieldName] = {
          name: localizationMap[fieldName]?.name ?? fieldName,
          description: localizationMap[fieldName]?.description || (localizationMap[fieldName]?.name ?? fieldName)

        };
      }
    }
    this.daeFieldBrowser = new DAEFieldBrowser(this.validFields, this);
    this.daeFieldBrowser.init().then(() => this.render());
  }

  static DEFAULT_OPTIONS = {
    window: {
      title: "EFFECT.ConfigTitle",
      resizable: true
    },
    position: {
      height: "auto" as "auto",
      width: 900
    },
    classes: ["sheet", "active-effect-config", "window-app", "dae"],
    actions: {
      addSpecialDuration: DAEActiveEffectConfig.#onAddSpecialDuration,
      deleteSpecialDuration: DAEActiveEffectConfig.#onDeleteSpecialDuration
    }
  };

  static PARTS: Record<string, foundry.applications.api.HandlebarsApplicationMixin.HandlebarsTemplatePart> = foundry.utils.mergeObject(super.PARTS ?? {}, {
    details: { template: "./modules/dae/templates/DAESheetConfig/Details.hbs", scrollable: [""] },
    duration: { template: "./modules/dae/templates/DAESheetConfig/Duration.hbs" },
    changes: { template: "./modules/dae/templates/DAESheetConfig/Changes.hbs", scrollable: ["scrollable"] }
  }, { inplace: false });

  /* ----------------------------------------- */
  getOptionsForSpec(spec?: ActiveEffect.ChangeData) {
    if (!spec?.key) return undefined;
    if (spec.key.includes("tokenMagic"))
      return this.tokenMagicEffects;
    if (spec.key === "macro.CE") return this.ceEffectList;
    if (spec.key === "macro.StatusEffect") return this.statusEffectList;
    if (spec.key === "StatusEffect") return this.statusEffectList;
    if (spec.key === "ATL.preset") return this.ATLPresets;
    if (spec.key === "ATL.sight.visionMode") return this.ATLVisionModes;
    return daeSystemClass.getOptionsForSpec(spec);
  }

  async _prepareContext(options) {
    const context: DAEActiveEffectConfigRenderContext = await super._prepareContext(options);
    const document = this.document;
    if (document.parent instanceof CONFIG.Actor.documentClass || document instanceof CONFIG.Actor.documentClass) {
      this.validSpecsToUse = ValidSpec.actorSpecs[document.parent?.type ?? ""]
    }
    if (isEnchantment(document)) {
      document.transfer = false;
      // @ts-expect-error no dnd5e-types
      if (document.isAppliedEnchantment) {
        this.validSpecsToUse = ValidSpec.itemSpecs[document.parent?.type ?? ""] ?? ValidSpec.itemSpecs["union"];
      } else {
        let restrictionType = "union";
        if (document.parent instanceof CONFIG.Item.documentClass) {
          // @ts-expect-error no dnd5e-types
          const activity = document.parent.system.activities.find(
            a => a.type === "enchant" && a.effects.find(e => e.effect?.uuid === document?.uuid)
          );
          if (activity) {
            restrictionType = activity.restrictions.type;
          }
          this.validSpecsToUse = ValidSpec.itemSpecs[restrictionType || "union"] ?? ValidSpec.itemSpecs["union"];
        }
      }
    }
    if (!this.validSpecsToUse) {
      ui.notifications?.error("DAE | No valid specs found");
      // Continue with an empty spec set so the sheet still renders - returning a half-built
      // context makes the details template part fail on the missing fields
      this.validSpecsToUse = { allSpecs: [], allSpecsObj: {}, baseSpecs: [], baseSpecsObj: {}, derivedSpecs: [], derivedSpecsObj: {} };
    }
    this.validFields = { "__": { name: ""} }
    this.validFields = this.validSpecsToUse.allSpecs
      .filter(e => e._fieldSpec.includes(""))
      .reduce((mods, em) => {
        mods[em._fieldSpec] = {
          name: localizationMap[em._fieldSpec]?.name ?? em._label,
          description: localizationMap[em._fieldSpec]?.description ?? em._description
        };
        return mods;
      }, this.validFields);
    if (!isEnchantment(document)) {
      for (let fieldName of [...otherFieldsMap.keys()].sort((a, b) => a.toLocaleLowerCase() < b.toLocaleLowerCase() ? -1 : 1)) {
        this.validFields[fieldName] = {
          name: localizationMap[fieldName]?.name ?? fieldName,
          description: localizationMap[fieldName]?.description || (localizationMap[fieldName]?.name ?? fieldName)

        };
      }
    }
    this.daeFieldBrowser = new DAEFieldBrowser(this.validFields, this);
    this.daeFieldBrowser.init();
    if (document.flags?.dae?.specialDuration === undefined)
      foundry.utils.setProperty(document, "flags.dae.specialDuration", []);

    if (!document.flags?.dae?.stackable) {
      foundry.utils.setProperty(document, "flags.dae.stackable", "multi");
      foundry.utils.setProperty(context, "effect.flags.dae.stackable", "multi");
    }

    await daeSystemClass.editConfig();

    const allModes = Object.entries(CONST.ACTIVE_EFFECT_MODES)
      .reduce((obj, e) => {
        obj[e[1]] = i18n("EFFECT.MODE_" + e[0]);
        return obj;
      }, {});
    context.modes = allModes;
    context.specialDuration = daeSpecialDurations;
    context.showSpecialDurations = Object.keys(daeSpecialDurations)?.length > 1;
    context.macroRepeats = daeMacroRepeats;
    if (document.flags?.dae?.showIcon === true) await document.update({ flags: { dae: {showIcon: "always" } } });
    else if (document.flags?.dae?.showIcon === false) await document.update({ flags: { dae: { showIcon: "none" } } });
    context.showIconOptions = {
      "none": i18n("dae.ShowIcon.Options.Default"),
      "always": i18n("dae.ShowIcon.Options.Always"),
      "never": i18n("dae.ShowIcon.Options.Never")
    };
    context.stackableOptions = stackableOptions;

    if (document.parent) {
      context.isItemEffect = document.parent instanceof CONFIG.Item.documentClass;
      context.isActorEffect = document.parent instanceof CONFIG.Actor.documentClass;
    }
    context.submitText = "EFFECT.Submit";

    (context.source!.changes as DAEChange[]).forEach(change => {
      if ([-1, undefined].includes(this.validSpecsToUse.allSpecsObj[change.key]?.forcedMode)) {
        if (change.modes && options.force) error("DAE | change already has modes set", this.document, change);
        change.modes = allModes;
      } else if (this.validSpecsToUse.allSpecsObj[change.key]) {
        const mode = {};
        mode[this.validSpecsToUse.allSpecsObj[change.key]?.forcedMode] = allModes[this.validSpecsToUse.allSpecsObj[change.key]?.forcedMode];
        if (change.modes && options.force) error("DAE | change already has modes set", this.document, change);
        change.modes = mode;
      } /*else if (!this.validSpecsToUse.allSpecsObj[change.key].startsWith("flags.midi-qol")) {
        change.modes = allModes; //change.mode ? allModes: [allModes[CONST.ACTIVE_EFFECT_MODES.CUSTOM]];
      }*/

      if (this.validSpecsToUse.allSpecsObj[change.key]?.options){
        if (change.options && options.force) error("DAE | change already has options set", this.document, change);
        change.options = this.validSpecsToUse.allSpecsObj[change.key]?.options;
      } else {
        if (change.options && options.force) error("DAE | change already has options set", this.document, change);
        change.options = this.getOptionsForSpec(change);
      }
      if (!change.priority) change.priority = change.mode * 10;

      const fieldInfo = this.daeFieldBrowser.getFieldInfo(change.key);
      change.fieldName = fieldInfo.name;
      change.fieldDescription = fieldInfo.description;
      if (fieldInfo.name === change.key && !change.key.startsWith("flags")) {
        // Could not find the key so set the name to <UNKNOWN>
        change.fieldName = "<UNKNOWN>";
      }
      // Some SRD/Player's Handbook effects have string fields enclosed in quotes which confuses DAEs selection process
      // Stripping them off is safe since the field is still a string
      if (typeof change.value === "string") {
        change.value = change.value.replace(/^(["'])(.*)\1$/, "$2")
      }
      // Mark changes that have a registered pluggable editor
      const fieldEditor = getFieldEditor(change.key);
      if (fieldEditor) {
        change.hasEditor = true;
        change.editorIcon = fieldEditor.icon ?? "fas fa-edit";
        change.editorTooltip = fieldEditor.tooltip ?? "Edit";
      }
    });

    // TODO (Michael): Foundry calendar here?
    const simpleCalendar = globalThis.SimpleCalendar?.api;
    if (simpleCalendar && context.document.duration?.startTime) {
      const dateTime = simpleCalendar.formatDateTime(simpleCalendar.timestampToDate(context.document.duration.startTime));
      context.startTimeString = dateTime.date + " " + dateTime.time;
      if (context.document.duration.seconds) {
        const duration = simpleCalendar.formatDateTime(simpleCalendar.timestampToDate(context.document.duration.startTime + context.document.duration.seconds));
        context.durationString = duration.date + " " + duration.time;
      }
    }
    foundry.utils.setProperty(context.document, "flags.dae.durationExpression", document.flags?.dae?.durationExpression);
    if (!context.document.flags?.dae?.specialDuration || !(context.document.flags.dae.specialDuration instanceof Array))
      foundry.utils.setProperty(context.document.flags, "dae.specialDuration", []);
    context.sourceName = await document.sourceName;
    context.midiActive = globalThis.MidiQOL !== undefined;
    context.isEnchantment = isEnchantment(document);
    context.isConditionalActivationEffect = document.parent?.name === i18n("dae.ConditionalEffectsItem");
    context.transfer = document.transfer;
    if (context.isConditionalActivationEffect) {
      context.transfer = false;
      context.document.transfer = false;
    }
    return context;
  }

  updateFieldInfo() {
    const changes = this.document.changes;
    changes.forEach((change, index) => {
      const fieldInfo = this.daeFieldBrowser.getFieldInfo(change.key);
      const row = this.element?.querySelector(`.effect-change[data-index="${index}"]`);
      const fieldName = row?.querySelector(".dae-field-name");
      const fieldDescription = row?.querySelector(".dae-field-description");
      if (fieldName && fieldDescription) {
        fieldName.textContent = fieldInfo.name;
        fieldDescription.textContent = fieldInfo.description;
      }
    });
  }

  async _onRender(context, options) {
    // @ts-expect-error wait 'til types de-stubs, then type this properly
    const currTabId: string | undefined = Object.values(context.tabs)?.find(i => i.active)?.id;
    if (currTabId !== "changes") this.position.height = this.element.offsetHeight ?? "auto";
    const keyInputs = Array.from(this.element.querySelectorAll(".key-input"));
    for (const keyInput of keyInputs) {
      keyInput.addEventListener("click", this.#onKeyInputInteraction.bind(this));
      keyInput.addEventListener("input", this.#onKeyInputInteraction.bind(this));
    }
    const transferCheckBox = Array.from(this.element.querySelectorAll(".transferCheckbox"));
    for (const checkbox of transferCheckBox) {
      checkbox.addEventListener("change", (event) => {
        this.submit({ preventClose: true })?.then(() => this.render());
      });
    }
    new foundry.applications.ux.DragDrop.implementation({
      // dragSelector: ".dae-change-drag-handle",
      dropSelector: ".value",
      callbacks: {
        drop: this._onDrop.bind(this)
      }
    }).bind(this.element);
    // Pluggable editor buttons
    const editButtons = Array.from(this.element.querySelectorAll<HTMLAnchorElement>(".dae-edit-value"));
    for (const btn of editButtons) {
      btn.addEventListener("click", this.#onEditValue.bind(this));
    }
  }
  changeTab(tab: string, group: string, options) {
    let autoPos: foundry.applications.api.ApplicationV2.Position = { ...this.position, height: "auto" };
    this.setPosition(autoPos);
    super.changeTab(tab, group, options);
    // Don't want to allow resizing height for changes tab, as that's handled by resizing the textareas themselves
    if (tab === "changes") return;
    let newPos = { ...this.position, height: this.element.offsetHeight };
    this.setPosition(newPos);
  }

  #onKeyInputInteraction(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    this.daeFieldBrowser.setInput(input);

    if (event.type === "click") {
      this.daeFieldBrowser.updateBrowser();
    } else if (event.type === "input") {
      this.daeFieldBrowser.debouncedUpdateBrowser();
    }
  }

  public onFieldSelected(): void {
    this.submit({ preventClose: true })?.then(() => this.render());
  }

  async #onEditValue(event: Event): Promise<void> {
    const btn = event.currentTarget as HTMLElement;
    const index = Number(btn.dataset.index);
    const change = this.document.changes[index];
    if (!change) return;

    const registration = getFieldEditor(change.key);
    if (!registration) return;

    // Read current value from the textarea (may have unsaved edits)
    const textarea = this.element.querySelector<HTMLTextAreaElement>(
      `textarea[name="changes.${index}.value"]`
    );
    const currentValue = textarea?.value ?? change.value ?? "";

    const result = await registration.editor(currentValue, {
      key: change.key,
      effect: this.document,
      parent: this.document.parent as Actor | Item | null,
      changeIndex: index,
      app: this,
    });

    if (result !== null && result !== undefined) {
      if (textarea) textarea.value = result;
      this.submit({ preventClose: true })?.then(() => this.render());
    }
  }

  /* ----------------------------------------- */

  _onDragStart(ev) { }

  // TODO: What is this actually for?
  async _onDrop(ev: DragEvent) {
    ev.preventDefault();
    const data: any = foundry.applications.ux.TextEditor.getDragEventData(ev);
    const item = await fromUuid(data.uuid);
    const targetValue = (ev.target as HTMLInputElement)?.value?.split(",")[1];
    if (data.uuid && ev.target) {
      (ev.target as HTMLInputElement).value = data.uuid + (targetValue ? `, ${targetValue}` : "");
      this.submit({ preventClose: true })?.then(() => this.render());
    }

    if (data.fieldName) {
      if (ev.target) (ev.target as HTMLInputElement).value = data.fieldName;
      this.daeFieldBrowser.debouncedUpdateBrowser();
      // TODO need to update the description when selected.
    }
  }

  static #onAddSpecialDuration() {
    // @ts-expect-error v13 stubby
    const submitData = this._processFormData(null, this.form, new foundry.applications.ux.FormDataExtended(this.form));
    const specialDuration = Object.values(submitData.flags?.dae?.specialDuration ?? {}) as string[];
    // @ts-expect-error v13 stubby
    return this.submit({
      preventClose: true,
      updateData: {
        "flags.dae.specialDuration": specialDuration.concat("None")
      }
    });
  }

  static #onDeleteSpecialDuration(event) {
    // @ts-expect-error v13 stubby
    const submitData = this._processFormData(null, this.form, new foundry.applications.ux.FormDataExtended(this.form));
    const specialDuration = Object.values(submitData.flags?.dae?.specialDuration ?? {}) as string[];
    const idx = Number(event.target.closest("li").dataset.index) || 0;
    specialDuration.splice(idx, 1);
    // @ts-expect-error v13 stubby
    return this.submit({
      preventClose: true,
      updateData: {
        "flags.dae.specialDuration": specialDuration
      }
    });
  }

  async _processSubmitData(event, form, submitData) {
    const document = this.document;
    for (let change of (submitData.changes ?? []) as DAEChange[]) {
      if (typeof change.priority === "string") change.priority = Number(change.priority);
      if (change.priority === undefined || isNaN(change.priority ?? NaN)) change.priority = change.mode ? change.mode * 10 : 0;
    }
    if (!submitData.tint || submitData.tint === "") submitData.tint = null;
    // fixed for very old items
    if (document.origin?.includes("OwnedItem.")) submitData.origin = document.origin.replace("OwnedItem.", "Item.");
    if (submitData.flags?.dae?.enableCondition?.length > 0) submitData.transfer = false;
    if (submitData.transfer && !isEnchantment(document)) submitData.origin = document.parent?.uuid;
    else delete submitData.origin;
    if (isEnchantment(document)) submitData.transfer = false;
    submitData.statuses ??= [];
    foundry.utils.setProperty(submitData, "flags.dae.specialDuration", Array.from(Object.values(submitData.flags?.dae?.specialDuration ?? {})))
    await this.document.update(submitData);

  }
  /* ----------------------------------------- */


  async _preClose(options) {
    await super._preClose(options);
    if (this.daeFieldBrowser && this.daeFieldBrowser.browserElement) {
      this.daeFieldBrowser.browserElement.remove();
      this.daeFieldBrowser.browserElement = null;
    }
    for (let change of this.document._source.changes as DAEChange[]) {
      delete change.modes;
      delete change.options;
    }
  }
}

interface DAEActiveEffectConfigRenderContext extends foundry.applications.sheets.ActiveEffectConfig.RenderContext {
  modes?: Record<number, string>;
  specialDuration?: Record<string, string>;
  showSpecialDurations?: boolean;
  macroRepeats?: Record<string, string>
  stackableOptions?: Record<string, string>;
  isItemEffect?: boolean;
  isActorEffect?: boolean;
  submitText?: string;
  startTimeString?: string;
  durationString?: string;
  sourceName?: string;
  midiActive?: boolean;
  isEnchantment?: boolean;
  isConditionalActivationEffect?: boolean;
  transfer?: boolean;
}

export function geti18nTranslations() {
  let translations = game.i18n?.translations["dae"];
  // if (!translations) translations = game.i18n._fallback["dae"];
  return translations ?? {};
}

Hooks.once("setup", () => {
  foundry.applications.apps.DocumentSheetConfig.registerSheet(
    CONFIG.ActiveEffect.documentClass,
    "core",
    DAEActiveEffectConfig,
    {
      label: i18n("dae.EffectSheetLabel"),
      makeDefault: true,
      canBeDefault: true,
      canConfigure: true
    });
})

export function isEnchantment(effect: ActiveEffect): boolean {
  //@ts-expect-error no dnd5e-types
  return effect.type === "enchantment";
}

interface DAEChange extends ActiveEffect.ChangeData {
  modes?: Record<number, string>;
  options?: Record<string, string>;
  fieldName?: string;
  fieldDescription?: string;
  hasEditor?: boolean;
  editorIcon?: string;
  editorTooltip?: string;
}
