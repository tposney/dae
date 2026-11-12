import { applyActiveEffects, socketlibSocket } from "./GMAction.js";
import { warn, error, debug, setDebugLevel, i18n, debugEnabled, daeManagesTurnExpiry } from "../dae.js";
import { ActiveEffects } from "./apps/ActiveEffects.js";
import { macroActorUpdate } from "./daeMacros.js";
import { DAEChangeData, DAESystem, ValidSpec } from "./Systems/DAESystem.js";
import { DAESystemDND5E } from "./Systems/DAEdnd5e.js";
import { DIMEditor } from "./apps/DIMEditor.js";
import { isEnchantment, registerFieldEditor } from "./apps/DAEActiveEffectConfig.js";
import { AnyMutableObject, AnyObject, InexactPartial, InvalidUuid } from "fvtt-types/utils";
import { TokenOrDocument } from "../globals.js";
import { setupSpecialDurationHooks, getDeprecatedSpecialDurMap, fetchDurationParams, defaultInCombatExpiry } from "./specialDurations.js";
import { resolveItemFromEffect, resolveMacro, createFunctionMacro, getItemMacroCommand as _getItemMacroCommand } from "./lib/macroResolution.js";
import { registerChangeHandler, getChangeHandler, isRegisteredMacroKey, getChangeDestination, getAllMacroEffectKeys, type ChangeHandlerContext } from "./lib/changeHandlerRegistry.js";
import { filterEffectsForTargeting } from "./lib/effectFiltering.js";
import { handleExistingEffects, handleStackIncrement } from "./lib/stackingPolicy.js";
import { rewriteAtlChanges } from "./atlMigration.js";
import { applyCurrentHp, raisesCurrentHp } from "./lib/currentHp.js";
import { convertChangeValue, hasInlineRoll, resolveInlineRolls, rollEffectSource, rollInline, rollItemSource, type InlineRollRecord } from "./lib/inlineRolls.js";

const { SchemaField } = foundry.data.fields;

let templates = {};

export let aboutTimeInstalled: boolean = false;
export let simpleCalendarInstalled: boolean = false;
export let atlActive: boolean = false;
/** Cached value of the world setting "dae.atlCompatibility". Updated in fetchParams(). */
export let atlCompatMode: "legacy" | "runtime" | "migrate" | "full" = "legacy";
/** Convenience flags derived from atlCompatMode. */
export let atlRewriteAtPreWrite: boolean = false;  // layer A — enabled by "migrate" and "full"
export let atlRewriteAtRuntime: boolean = false;   // layer B — enabled by "runtime" and "full"
export let atlMigrateWorldData: boolean = false;   // layer C — enabled by "migrate" and "full"
export let midiActive: boolean = false;
export let ceInterface: {
  findEffects: () => ActiveEffect.Implementation[];
  findEffect: (input: {
    folderId?: string,
    effectId?: string,
    effectName?: string
  }) => ActiveEffect.Implementation | null;
  hasEffectApplied: (input: {
    effectId?: string,
    effectName?: string,
    uuid?: string
  }) => boolean;
  addEffect: (input: {
    effectId?: string,
    effectName?: string,
    effectData?: ActiveEffect.CreateData,
    uuid?: string,
    overlay?: boolean,
    origin?: string | null,
  }) => Promise<ActiveEffect.Implementation[]>;
  removeEffect: (input: {
    effectId?: string,
    effectName?: string,
    uuid?: string,
    origin?: string | null,
  }) => Promise<void>;
} | undefined;
export let localizationMap: Record<string, { name?: string, description?: string }> = {};
// export let useAbilitySave;
export let noDupDamageMacro: boolean;
export let disableEffects: boolean;
export let daeTitleBar: boolean;
export let DIMETitleBar: boolean;
export let daeColorTitleBar: boolean;
export let libWrapper: any;
export let actionQueue: foundry.utils.Semaphore;
// export let linkedTokens;
// export let DAESetupComplete;
export let DAEReadyComplete: boolean;
export let dependentConditions: boolean;
export let specialDurationExpiryAction: string = "default";

/**
 * Resolve the effective expiry action for special durations.
 * "default" falls through to core's CONFIG.ActiveEffect.expiryAction.
 */
export function resolveSpecialDurationExpiryAction(): string {
  if (specialDurationExpiryAction === "delete" || specialDurationExpiryAction === "update") {
    return specialDurationExpiryAction;
  }
  // "default" (or legacy "none") — use core's setting
  // @ts-expect-error v14 CONFIG.ActiveEffect.expiryAction
  return CONFIG.ActiveEffect.expiryAction ?? "update";
}

/**
 * Resolve the expiry action for a specific effect, checking per-effect flag first.
 * Per-effect flags.dae.expiryMode overrides the global setting.
 */
export function resolveEffectExpiryAction(effect: ActiveEffect.Implementation): "delete" | "update" {
  const mode = effect.getFlag("dae", "expiryMode") as string | undefined;
  if (mode === "delete") return "delete";
  if (mode === "suppress") return "update";
  // "default" or unset — use global setting
  return resolveSpecialDurationExpiryAction() === "delete" ? "delete" : "update";
}

// Track actors with pending status reconciliation to avoid duplicate reconciliations
const reconciliationPending = new Set<string>();
// Track actors with pending conditional effects processing to coalesce rapid-fire hook calls
const conditionalEffectsPending = new Set<string>();

// Track actor UUIDs that have had init macros fired (reset on world load)
export const daeInitMacroActors = new Set<string>();

// Effects pending init macro calls (queued before game.ready, processed in daeReadyActions)
export const pendingInitMacroEffects: { effectUuid: string, actorUuid: string }[] = [];

/** Return CONFIG.statusEffects as an array, handling systems (e.g. Crucible) that replace it with a plain object. */
export function getStatusEffectsArray(): any[] {
  return Array.isArray(CONFIG.statusEffects) ? CONFIG.statusEffects : Object.values(CONFIG.statusEffects);
}

// Re-export from shared library for backward compatibility
export const getItemMacroCommand = _getItemMacroCommand;

// --- Change handler registration (data-driven) ---
// Special change handlers: [key, onAdd, onRemove, destination]
const specialHandlers: [string, (ctx: ChangeHandlerContext) => Promise<any>, (ctx: ChangeHandlerContext) => Promise<any>, "local" | "GM"][] = [
  ["macro.CE",
    ctx => addConvenientEffectsChange(ctx.change.value, ctx.actor.uuid, ctx.effect.origin, ctx.context ?? {}, ctx.actor.isToken),
    ctx => removeConvenientEffectsChange(ctx.change.value, ctx.actor.uuid, ctx.effect.origin, ctx.actor.isToken), "local"],
  ["macro.StatusEffect",
    ctx => addConditionChange(ctx.actor, ctx.change, ctx.token, ctx.effect),
    ctx => removeConditionChange(ctx.actor, ctx.change, ctx.token ?? null, ctx.effect, ctx.context), "local"],
  ["StatusEffect",
    ctx => addConditionChange(ctx.actor, ctx.change, ctx.token, ctx.effect),
    ctx => removeConditionChange(ctx.actor, ctx.change, ctx.token ?? null, ctx.effect, ctx.context), "local"],
  ["macro.tokenMagic",
    ctx => addTokenMagicChange(ctx.actor, ctx.change, ctx.tokens),
    ctx => removeTokenMagicChange(ctx.actor, ctx.change, ctx.tokens, ctx.context), "local"],
  ["macro.createItem",
    ctx => addCreateItemChange(ctx.change, ctx.actor, ctx.effect, ctx.context),
    ctx => removeCreateItemChange(ctx.change.value, ctx.actor, ctx.effect, ctx.context), "GM"],
  ["macro.createItemRunMacro",
    ctx => addCreateItemChange(ctx.change, ctx.actor, ctx.effect, ctx.context),
    ctx => removeCreateItemChange(ctx.change.value, ctx.actor, ctx.effect, ctx.context), "GM"],
];
for (const [key, on, off, destination] of specialHandlers) {
  registerChangeHandler(key, { on, off, destination });
}
// Macro change handlers — batched through daeMacro (on/off are no-ops, dispatch handled by daeMacro)
const noop = async () => {};
for (const key of ["macro.execute", "macro.itemMacro", "macro.actorUpdate", "macro.activityMacro"]) {
  registerChangeHandler(key, { on: noop, off: noop, destination: "mixed", isMacroKey: true });
}

// Backward-compatible exports derived from registry
export let allMacroEffects = getAllMacroEffectKeys();
export const isMacroChangeKey = isRegisteredMacroKey;
export let macroDestination: Record<string, string> = {};
for (const key of allMacroEffects) {
  macroDestination[key] = getChangeDestination(key);
}

export let daeSystemClass: typeof DAESystem | typeof DAESystemDND5E;
if (!globalThis.daeSystems) globalThis.daeSystems = {};

// export let showDeprecation = true;

export const deprecatedKeyPatterns: { pattern: RegExp; replacement: (id: string) => string }[] = [
  { pattern: /^data\.abilities\.(\w{3})\.save$/, replacement: id => `system.abilities.${id}.bonuses.save` },
  { pattern: /^data\.abilities\.(\w{3})\.mod$/, replacement: id => `system.abilities.${id}.bonuses.check` },
  { pattern: /^data\.skills\.(\w{3})\.mod$/, replacement: id => `system.skills.${id}.bonuses.check` },
  { pattern: /^data\.skills\.(\w{3})\.passive$/, replacement: id => `system.skills.${id}.bonuses.passive` },
];

function flagChangeKeys(actor: Actor.Implementation, change: ActiveEffect.ChangeData) {
  if (!(["dnd5e"].includes(game.system.id ?? ""))) return;
  for (const { pattern, replacement } of deprecatedKeyPatterns) {
    const match = change.key.match(pattern);
    if (match) {
      console.error(`dae | deprecated change key ${change.key} found in ${actor.name} use ${replacement(match[1])} instead`);
      return;
    }
  }
}


/*
 * v14 WRAPPER for Actor.applyActiveEffects(phase).
 * Chains to core+dnd5e, then applies "missed" changes whose ValidSpec phase
 * differs from the phase core assigned them to.
 */
/** A change's effective application phase.
 *  - If the effect was authored through the DAE editor (`flags.dae.phaseStamped`), every change has an
 *    explicit phase, so `change.phase` is authoritative — including a deliberately-chosen "initial" on
 *    a key whose ValidSpec phase is "final".
 *  - Otherwise (legacy/foreign effects): a non-default phase is explicit and wins; the schema default
 *    "initial" defers to the ValidSpec phase so unstamped derived-key changes still apply at the right time.
 *  `effect` is supplied where `change.effect` isn't populated yet (the missed-changes scan). */
export function effectivePhase(change: { phase?: string, effect?: any }, spec?: { phase?: string }, effect?: any): string {
  const stamped = (effect ?? change?.effect)?.flags?.dae?.phaseStamped;
  if (stamped) return change?.phase ?? spec?.phase ?? "initial";
  if (change?.phase && change.phase !== "initial") return change.phase;
  return spec?.phase ?? change?.phase ?? "initial";
}

/** Collect each change in its ValidSpec phase, not its stored one, so it joins core's priority sort. */
export function daeShouldApplyChange(
  this: ActiveEffect.Implementation,
  wrapped: Function,
  change: DAEChangeData,
  options: { phase?: string } = {}
): boolean {
  if (disableEffects || !change?.key) return wrapped(change, options);
  // ATL.* is handled separately (rewritten to token.* or deferred to the ATL module).
  if (change.key.startsWith("ATL.")) return wrapped(change, options);
  const spec = ValidSpec.actorSpecs?.["union"]?.allSpecsObj?.[change.key]
    ?? ValidSpec.actorSpecs?.["union"]?.allSpecsObj?.[`token.${change.key}`];
  if (effectivePhase(change, spec, this) !== options?.phase) return false;
  /*
   * Phase is ours to decide; everything else is not. Delegate so the system still runs its own
   * checks — effect-level condition evaluation, per-change `conditions`, and `change.applied`.
   * Passing `change.phase` back in satisfies core's own `change.phase === options.phase` test,
   * which we have already answered above against the ValidSpec phase instead.
   */
  return wrapped(change, { ...options, phase: change.phase });
}

export function daeApplyActiveEffects(this: Actor.Implementation, wrapped: Function, phase: string) {
  if (disableEffects) {
    wrapped(phase);
    return;
  }

  debug("daeApplyActiveEffects: phase", phase, this.name);

  // Deprecation checks (before core filters effects)
  const deprecatedSpecialDurs = Object.keys(getDeprecatedSpecialDurMap());
  for (let effect of this.allApplicableEffects()) {
    if (effect.flags?.dae?.showIcon) {
      foundry.utils.logCompatibilityWarning(
        `dae | Effect "${effect.name}" on actor "${this.name}": flags.dae.showIcon is deprecated, use ActiveEffect.showIcon. Edit the effect or re-create it to auto-migrate.`,
        { once: true, stack: false }
      );
    }
    // combatEnd stays a special duration while another event holds the effect's one expiry slot, or it has a duration.
    // @ts-expect-error v14 duration.expiry not in fvtt-types yet
    const expiry = effect._source.duration?.expiry;
    // @ts-expect-error v14 duration.value not in fvtt-types yet
    const hasValue = typeof effect._source.duration?.value === "number";
    const slotTaken = !!expiry && expiry !== "combatEnd" && !(expiry === "turnStart" && hasValue);
    const deprecated = (effect.flags?.dae?.specialDuration ?? []).filter(sd => deprecatedSpecialDurs.includes(sd) && !(sd === "combatEnd" && (slotTaken || hasValue)));
    if (deprecated.length) {
      foundry.utils.logCompatibilityWarning(
        `dae | Effect "${effect.name}" on actor "${this.name}" uses deprecated dae special duration (${deprecated.join(", ")}). Edit the effect to migrate to native duration.expiry.`,
        { once: true, stack: false }
      );
    }
  }

  // Let core + dnd5e handle normal effect application:
  // - dnd5e: determineSuppression(), prepareEmbeddedData(), super call
  // - core: phase validation/tracking, change collection, sorting, token changes,
  //         status effects, applyChange() for each, overrides merge
  // Our daeApplyChange WRAPPER intercepts each applyChange call to add:
  //   phase correction (skip wrong-phase), ATL exclusion, bonusSelector expansion,
  //   field mappings, dae.eval, @data rewrite, stacks
  wrapped(phase);

  // ATL → token.* runtime rewrite (Layer B — enabled by "runtime" and "full").
  // Core's actor.applyActiveEffects already split off "token.*" prefixed changes; ATL.* keys
  // were ignored. Here we walk the active effects, rewrite each ATL.* change to the equivalent
  // token.* change(s) via the shared transformer, and append them to tokenActiveEffectChanges
  // so TokenDocument.applyActiveEffects(phase) processes them as if authored natively.
  if (atlRewriteAtRuntime) {
    let extras: DAEChangeData[] | null = null;
    for (const effect of this.appliedEffects) {
      if (effect.disabled || effect.isSuppressed) continue;
      // @ts-expect-error v14 effect.system.changes
      for (const change of (effect.system.changes as DAEChangeData[])) {
        if (!change?.key || !change.key.startsWith("ATL.")) continue;
        if (change.phase !== phase) continue;
        const rewrites = rewriteAtlChanges([change as any]);
        if (rewrites === undefined || rewrites.length === 0) continue;
        for (const r of rewrites) {
          if (!r.key.startsWith("token.")) continue;
          const c = foundry.utils.deepClone(r) as DAEChangeData;
          c.key = c.key.slice(6); // strip "token." prefix to match core's expectation
          c.effect = effect;
          extras ??= [];
          extras.push(c);
        }
      }
    }
    if (extras && extras.length > 0) {
      // @ts-expect-error v14 tokenActiveEffectChanges
      this.tokenActiveEffectChanges[phase] ??= [];
      // @ts-expect-error v14 tokenActiveEffectChanges
      this.tokenActiveEffectChanges[phase].push(...extras);
    }
  }

  /*
   * Core inflates a vision mode's defaults (TokenDocument#_inflateVisionModeChange) immediately
   * after applying the sight.visionMode change, assigning over sight.*. An explicit sibling change
   * therefore only survives if it is applied later. Keep visionMode first among equal-priority
   * sight.* changes so an explicit value wins whatever order it was authored in. Sort is stable, so
   * nothing else moves.
   */
  {
    const tac = (this as any).tokenActiveEffectChanges?.[phase] as DAEChangeData[] | undefined;
    if (Array.isArray(tac) && tac.some(c => c.key === "sight.visionMode")) {
      const rank = (c: DAEChangeData) => (c.key === "sight.visionMode" ? 0 : 1);
      tac.sort((a, b) => ((a.priority ?? 0) - (b.priority ?? 0)) || (rank(a) - rank(b)));
    }
  }

  if (phase === "final") detectSuppressionChanges(this);
}

/**
 * Side-effecting change keys (macro.*, StatusEffect, macro.CE, ...) need an "off" when an effect
 * stops applying. Deleting, disabling and editing an effect are all document events, so the
 * document hooks see them. Suppression is not: `isSuppressed` is a getter, recomputed every
 * preparation from equipment, antimagic and the origin effect's active state, and nothing is ever
 * written. Nothing fired, so an unequipped item left its macros' work in place.
 *
 * Data preparation is the one place where all of that is already resolved, so the transition is
 * detected here — after `wrapped(phase)`, so suppression reflects this preparation — and the work
 * is pushed onto the action queue rather than done inline. Detection only: no writes, no awaits.
 *
 * The previous value lives on the effect document, which survives preparation. First sight seeds it
 * without firing, so an effect appearing already-suppressed is not mistaken for a transition. After
 * a reload everything reseeds, which means a transition that happened while the client was away is
 * not recovered — inherent to edge detection.
 */
function detectSuppressionChanges(actor: Actor.Implementation): void {
  // Clones and sheet previews prepare too, and their effects are fresh objects; only reconcile
  // actors that are really in the world.
  if (!actor.id || (!actor.isToken && !game.actors?.has(actor.id))) return;
  // Every client prepares every actor; all of them track the state, one acts on it.
  const acts = actsForActor(actor);
  for (const effect of actor.allApplicableEffects()) {
    const suppressed = !!effect.isSuppressed;
    const previous = (effect as any)._daeSuppressed;
    (effect as any)._daeSuppressed = suppressed;
    if (previous === undefined || previous === suppressed || !acts) continue;
    scheduleSuppressionChange(actor, effect, suppressed);
  }
}

/** The client that does an actor's work no single user triggered: the active GM, else the first active owner. */
function actsForActor(actor: Actor.Implementation): boolean {
  const gm = game.users?.activeGM;
  if (gm) return gm.isSelf;
  const owner = game.users?.filter(u => u.active && actor.testUserPermission(u, "OWNER")).sort((a, b) => a.id!.localeCompare(b.id!))[0];
  return !!owner?.isSelf;
}

function scheduleSuppressionChange(
  actor: Actor.Implementation,
  effect: ActiveEffect.Implementation,
  suppressed: boolean
): void {
  actionQueue.add(async () => {
    try {
      // Re-read: the queue may have lagged behind further changes.
      if (!!effect.isSuppressed !== suppressed) return;
      Hooks.callAll("dae.suppressionChanged", effect, suppressed);
      // @ts-expect-error v14 effect.system.changes
      const changes = (effect.system?.changes ?? []) as ActiveEffect.ChangeData[];
      const sideEffecting = changes.filter(c => c.key && (getChangeHandler(c.key) || raisesCurrentHp(effect, c)));
      if (sideEffecting.length === 0) return;
      const tokens = actor.isToken ? [actor.token?.object] : actor.getActiveTokens();
      await processEffectChanges(suppressed ? "off" : "on", actor, tokens as any, effect, undefined,
        sideEffecting, { "expiry-reason": suppressed ? "effect-suppressed" : "effect-unsuppressed" });
    } catch (err) {
      console.warn("dae | suppression change processing failed", effect?.name, err);
    }
  });
}

// Keep the old name as an alias for backward compatibility with any external callers
export const applyDaeEffects = daeApplyActiveEffects;

/**
 * WRAPPER for ActiveEffect.applyChange (static method).
 * Handles all per-change DAE transformations before delegating to Foundry core.
 *
 * Transformations applied:
 * - Field mappings (deprecated key migration)
 * - flagChangeKeys (deprecation warnings for old dnd5e key patterns)
 * - midi-qol.optional key fix (missing .all suffix)
 * - OverTime key suffix (randomID to prevent flag collision)
 * - @data. deprecation rewrite
 * - dae.eval() and dae.roll() expression evaluation
 * - Stack count (multi-apply for stacked effects)
 */
export function daeApplyChange(
  this: any,
  wrapped: Function,
  targetDoc: any,
  change: DAEChangeData,
  options: { replacementData?: AnyMutableObject, modifyTarget?: boolean } = {}
): any {
  if (disableEffects) {
    return wrapped(targetDoc, change, options);
  }

  // --- Item changes: actor rollData for @-expression resolution (core leaves @UUID[...] links alone) ---
  if (targetDoc instanceof CONFIG.Item.documentClass) {
    const item = targetDoc as Item.Implementation;
    // rollData so item enchantment effects can use @abilities.str.mod / @mod.
    if (item.actor && !options.replacementData) {
      const rollData = item.actor.getRollData() as AnyMutableObject;
      rollData.mod = (rollData.abilities as any)?.[(item as any).abilityMod]?.mod ?? 0;
      options.replacementData = rollData;
    }
    return wrapped(targetDoc, change, options);
  }

  if (!(targetDoc instanceof CONFIG.Actor.documentClass)) {
    return wrapped(targetDoc, change, options);
  }

  const actor = targetDoc as Actor.Implementation;

  // A transfer effect's inline rolls were rolled when it reached the actor; their totals are stored on the effect.
  if (hasInlineRoll(change.value)) change.value = resolveInlineRolls(change);

  // --- ATL handling ---
  // When atlRewriteAtRuntime is on (Layer B), ATL.* changes have already been pre-translated
  // into token.* synthetic changes in daeApplyActiveEffects (see below) and routed to the
  // TokenDocument's tokenActiveEffectChanges, so we never reach here with an ATL.* key.
  // When it's off, defer the key to the ATL module by returning empty (the legacy behavior).
  if (change.key.startsWith("ATL.")) return {};

  // --- bonusSelector expansion ---
  // Synthetic keys like "system.bonuses.All-Attacks" expand into multiple real keys
  // (e.g. system.bonuses.mwak.attack, system.bonuses.rwak.attack, etc.)
  if (daeSystemClass.bonusSelectors[change.key]) {
    const selector = daeSystemClass.bonusSelectors[change.key];
    if (selector.deprecatedFor) {
      foundry.utils.logCompatibilityWarning(
        `dae | Actor ${actor?.name} ${change.key} is deprecated, use ${selector.deprecatedFor} instead.`,
        { once: true, stack: false }
      );
    }
    const overrides = {};
    const keys: string[] = selector.replaceList
      ?? selector.attacks.map((at: string) => `system.bonuses.${at}.${selector.selector}`);
    for (const key of keys) {
      const c = foundry.utils.deepClone(change) as DAEChangeData;
      c.key = key;
      // Call through the full applyChange chain (including this WRAPPER)
      // so expanded changes get field mappings, dae.eval, phase checks, etc.
      // @ts-expect-error v14 static applyChange
      const result = CONFIG.ActiveEffect.documentClass.applyChange(targetDoc, c, options);
      if (result && typeof result === "object") Object.assign(overrides, result);
    }
    return overrides;
  }

  // --- Field mappings (deprecated key migration) ---
  if (daeSystemClass.fieldMappings[change.key]) {
    const mapping = daeSystemClass.fieldMappings[change.key];
    const displayMapping = typeof mapping === "string" ? mapping : `${mapping.key}${mapping.value !== undefined ? ` ${mapping.value}` : ""}`;
    foundry.utils.logCompatibilityWarning(
      `dae | Actor ${actor.name} ${change.key} deprecated use ${displayMapping} instead.`, { once: true, stack: false }
    );
    if (typeof mapping !== "string") {
      change.key = mapping.key;
      if (mapping.value !== undefined) change.value = mapping.value;
      if ((mapping as any).type !== undefined) change.type = (mapping as any).type;
      else if (mapping.mode !== undefined) {
        // Legacy field mapping with numeric mode — convert to v14 string type
        const modeToType: Record<number, string> = { 0: "custom", 1: "multiply", 2: "add", 3: "downgrade", 4: "upgrade", 5: "override" };
        change.type = modeToType[mapping.mode as number] ?? "custom";
      }
    } else if (mapping.startsWith("system.traits.da") && mapping.endsWith(".value")) {
      const damageType = change.key.split(".").slice(-1)[0];
      change.key = mapping;
      change.value = damageType;
      if (change.type === "custom") change.type = "add";
    } else {
      if (change.key.includes("DR") && change.value?.length > 0) change.value = `-(${change.value})`;
      if (debugEnabled > 0)
        warn("Doing field mapping mapping ", change.key, mapping);
      change.key = mapping;
    }
  }

  // --- flagChangeKeys (deprecation warnings for old dnd5e key patterns) ---
  flagChangeKeys(actor, change);

  // --- midi-qol.optional fix (missing .all suffix) ---
  if (change.key.startsWith("flags.midi-qol.optional")) {
    const parts = change.key.split(".");
    // Only apply deprecation fix for bare category keys like flags.midi-qol.optional.NAME.save (5 parts)
    // Don't match deeper keys like flags.midi-qol.optional.NAME.damage.save where save is an action type
    if (parts.length === 5 && ["save", "check", "skill", "damage", "attack"].includes(parts[4])) {
      console.error(`dae/midi-qol | deprecation error ${change.key} should be ${change.key}.all on actor ${actor.name}`)
      change.key = `${change.key}.all`;
    }
  }

  // --- OverTime suffix (randomID to prevent flag collision between effects) ---
  if (change.key === "flags.midi-qol.OverTime") change.key = `flags.midi-qol.OverTime.${foundry.utils.randomID()}`;

  // --- Value transformations (resolved once, then applied for each stack) ---

  // @data. deprecation rewrite
  if (typeof change.value === "string" && change.value.includes("@data.")) {
    const parentInfo = change.effect?.parent ? ` on ${change.effect.parent.name} (${change.effect.parent.id})` : '';
    console.warn(`dae | @data.key is deprecated, use @key instead (${change.effect?.name} (${change.effect?.id})${parentInfo} has value ${change.value})`);
    change.value = change.value.replace(/@data./g, "@");
  }

  // dae.eval() and dae.roll() expression handling
  const stacks = change.count ?? change.effect?.flags?.dae?.stacks ?? 1;
  const hadAtRef = typeof change.value === "string" && change.value.includes("@");
  // FormulaFields keep "@" for roll time, so core never resolves @stackCount in them.
  if (typeof change.value === "string" && change.value.includes("@stackCount")) {
    change.value = change.value.replaceAll("@stackCount", String(stacks));
  }
  // A dnd5e formula field keeps its dae.eval for dnd5e to evaluate late, with complete roll data (replaceFormulaData).
  const FormulaField = globalThis.dnd5e?.dataModels?.fields?.FormulaField;
  const formulaTarget = !!FormulaField && ValidSpec.actorSpecs?.[actor.type]?.allSpecsObj?.[change.key]?.fieldType instanceof FormulaField;
  if (typeof change.value === "string" && !(formulaTarget && !change.value.includes("dae.roll("))
    && (change.value.includes("dae.eval(") || change.value.includes("dae.roll("))) {
    const conditionData = actor.getRollData();
    foundry.utils.mergeObject(conditionData, { stackCount: stacks, effect: change.effect?.toObject() });
    change.value = daeSystemClass.safeEvalExpression(change.value, conditionData);
  }

  // Core substitutes @refs on non-schema keys but casts with Number(), so arithmetic yields 0.
  // Evaluate here, as NumberField does for schema keys. Numeric targets only - formula-valued
  // flags (midi optional bonuses and the like) must keep their string.
  if (typeof change.value === "string" && hadAtRef && change.key.startsWith("flags.") && !change.value.includes("[[")) {
    const current = foundry.utils.getProperty(actor, change.key);
    const fieldType = ValidSpec.actorSpecs?.[actor.type]?.allSpecsObj?.[change.key]?.fieldType;
    if (typeof current === "number" || fieldType === "number") {
      const resolved = Roll.replaceFormulaData(change.value, actor.getRollData() as AnyObject, { missing: "0", warn: false });
      const foreignWord = /\b(?!(?:floor|ceil|round|abs|min|max|pow|sqrt|sign|clamp|clamped)\b)[a-zA-Z_]\w*/;
      if (!foreignWord.test(resolved)) {
        try {
          const total = Roll.create(resolved).evaluateSync({ strict: false }).total;
          if (Number.isFinite(total)) change.value = String(total);
        } catch (err) {
          warn("daeApplyChange | could not evaluate", change.key, resolved, err);
        }
      }
    }
  }

  // --- Stack count (multi-apply for stacked effects) ---
  const overrides = {};

  // Custom type changes are handled directly to avoid a v14 core bug:
  // DataField.applyChange runs clean()/initialize() on _applyChangeCustom's undefined
  // return (meaning "no change"), converting it to the field's initial value (e.g. "" for
  // StringField), then applying that via setProperty — resetting the value the hook set.
  // By firing the hook directly, we skip the field-based path entirely.
  if (change.type === "custom") {
    for (let i = 0; i < stacks; i++) {
      const preVal = foundry.utils.getProperty(targetDoc, change.key);
      Hooks.call("applyActiveEffect", targetDoc, change, preVal, change.value, {});
      const postVal = foundry.utils.getProperty(targetDoc, change.key);
      if (postVal !== preVal && postVal !== undefined) {
        overrides[change.key] = postVal;
      }
    }
    return overrides;
  }

  for (let i = 0; i < stacks; i++) {
    const result = wrapped(targetDoc, change, options);
    if (result && typeof result === "object") Object.assign(overrides, result);
  }
  return overrides;
}

export async function addCreateItemChange(change: { key: string, value: string }, actor: Actor.Implementation, effect: ActiveEffect.Implementation, context: unknown) {
  let itemDetails = change.value
  if (itemDetails.startsWith("@")) {
    itemDetails = Roll.replaceFormulaData(change.value, actor.getRollData() as AnyObject, { missing: "", warn: false });
  }
  await socketlibSocket.executeAsGM("createActorItem", { uuid: actor.uuid, itemDetails, effectUuid: effect.uuid, callItemMacro: change.key === "macro.createItemRunMacro" })
}

export async function removeCreateItemChange(itemId: string, actor: Actor.Implementation, effect: ActiveEffect.Implementation, context: any = {}) {
  if (itemId.startsWith("@")) {
    itemId = Roll.replaceFormulaData(itemId, actor.getRollData() as AnyObject, { missing: "", warn: false });
  }
  let [uuid, option] = itemId.split(",").map(s => s.trim());
  if (option === "permanent") return; // don't delete permanent items
  const itemsToDelete = (effect.flags?.dae?.itemsToDelete ?? []).slice();
  if (itemsToDelete.length === 0) return;
  if (!(context.effectDeleted || context.itemDeleted)) await effect.setFlag("dae", "itemsToDelete", []);
  await socketlibSocket.executeAsGM("removeActorItem", { uuid: actor.uuid, itemUuid: itemId, itemUuids: itemsToDelete, context })
}

export async function addTokenMagicChange(actor: Actor.Implementation, change: ActiveEffect.ChangeData, tokens: (TokenOrDocument | null | undefined)[]) {
  const tokenMagic = globalThis.TokenMagic;
  if (!tokenMagic) return;
  for (let token of tokens) {
    if (token instanceof foundry.canvas.placeables.Token) token = token.document;
    const tokenUuid = token?.uuid;
    await socketlibSocket.executeAsGM("applyTokenMagic", { tokenUuid, effectId: change.value })
  }
}

export async function removeTokenMagicChange(actor: Actor.Implementation, change: ActiveEffect.ChangeData, tokens: (TokenOrDocument | null | undefined)[], context: any = {}) {
  const tokenMagic = globalThis.TokenMagic;
  if (!tokenMagic) return;
  for (let token of tokens) {
    if (token instanceof foundry.canvas.placeables.Token) token = token.document;
    const tokenUuid = token?.uuid;
    await socketlibSocket.executeAsGM("removeTokenMagic", { tokenUuid, effectId: change.value })
  }
}

async function myRemoveCEEffect(effectName: string, uuid: string, origin: string | undefined | null, isToken: boolean) {
  await delay(1); // let all of the stuff settle down
  return await ceInterface?.removeEffect({ effectName, uuid, origin });
}
export async function removeConvenientEffectsChange(effectName: string, uuid: string, origin: string | undefined | null, isToken: boolean) {
  if (isToken) await delay(1); // let all of the stuff settle down
  return await myRemoveCEEffect(effectName, uuid, origin, isToken);
}

async function myAddCEEffectWith(effectData: any, uuid: string, origin: string | undefined | null, overlay: boolean, isToken: boolean) {
  if (!ceInterface) return;
  await delay(1);
  return await ceInterface.addEffect({ effectName: effectData.name, uuid, origin, effectData, overlay });
}

export async function addConvenientEffectsChange(effectName: string, uuid: string, origin: string | undefined | null, context: any, isToken: boolean): Promise<ActiveEffect.Implementation[] | undefined> {
  if (!ceInterface) return;
  let ceEffect: ActiveEffect.Implementation | null;
  ceEffect = ceInterface.findEffect({ effectName });
  if (!ceEffect) return;
  let effectData = foundry.utils.mergeObject(ceEffect.toObject(), context.metaData);
  effectData.origin = origin;
  return await myAddCEEffectWith(effectData, uuid, origin, false, isToken);
}

export async function addConditionChange(actor: Actor.Implementation, change: ActiveEffect.ChangeData, token: foundry.canvas.placeables.Token.Implementation | undefined, effect: ActiveEffect.Implementation): Promise<ActiveEffect.Implementation[] | undefined> {
  // This is from macro.statusEffect
  const condition = getStatusEffectsArray().find(se => se.id === change.value);
  if (!condition) return;
  const overlay = foundry.utils.getProperty(effect, "flags.core.overlay") as boolean;
  if (change.value.startsWith("Convenient Effect")) {
    console.warn("Convenient Effect change detected in macro.StatusEffect which is deprecated use macro.CE instead");
    console.warn(`Actor: ${actor.name} Change: ${change.value} Token: ${token?.name} Effect: ${effect.name} ${effect.uuid}`);
    const effectName = change.value.split("Convenient Effect: ")[1];
    return await ceInterface?.addEffect({ effectName, uuid: actor.uuid, origin: effect.uuid, overlay });
  } else if (change.value.startsWith("zce-")) {
    console.warn("Convenient Effect change detected in macro.StatusEffect which is deprecated use macro.CE instead");
    console.warn(`Actor: ${actor.name} Change: ${change.value} Token: ${token?.name} Effect: ${effect.name} ${effect.uuid}`);
    const effectId = change.value.replace("zce-", "ce-");
    return await ceInterface?.addEffect({ effectId, uuid: actor.uuid, origin: effect.uuid, overlay });
  }
  if ((condition.statuses as string[])?.length > 1 && !condition?._id) {
    condition._id = condition.id.replaceAll(/[ :,.\+\-\*\&\^\%\$\#\@\!\[\]{}\(\)]/g, "").padEnd(16, "0").slice(-16);
  }
  await toggleActorStatusEffect(actor, condition.id, { active: true, origin: effect.uuid, flags: {dnd5e: {dependentOn: effect.uuid}} });
}

export async function removeConditionChange(actor: Actor.Implementation, change: ActiveEffect.ChangeData, token: foundry.canvas.placeables.Token.Implementation | null, effect: ActiveEffect.Implementation, context: any = {}) {
  if (change.value.startsWith("Convenient Effect")) {
    const effectName = change.value.split("Convenient Effect: ")[1];
    return await ceInterface?.removeEffect({ effectName, uuid: actor.uuid, origin: effect.uuid });
  } else if (change.value.startsWith("zce-") && ceInterface) {
    const effectId = change.value.replace("zce-", "ce-");
    return await ceInterface?.removeEffect({ effectId, uuid: actor.uuid, origin: effect.uuid });
  }
  /*
   * Remove the condition document this change created.
   *
   * Skipped when the parent is being deleted: addConditionChange links the condition with
   * flags.dnd5e.dependentOn, and dnd5e deletes dependents itself in _onDeleteOperation, so deleting
   * here as well races it and throws "does not exist". That is the case the old
   * "Effect will auto remove" comment described — it just was not true for the other three ways an
   * effect stops applying (change removed, disabled, suppressed), which is why those leaked.
   * removeCreateItemChange already guards on the same two context flags.
   */
  if (context.effectDeleted || context.itemDeleted) return;
  /*
   * Re-resolve at execution time rather than capturing an id. Condition documents use a static id
   * derived from the status (dnd5eprone000000), so an id captured now can name a *different*
   * document by the time a queued task runs — deleting a condition some other effect has since
   * applied. Matching on origin identifies the one this change actually created.
   */
  const find = () => actor.effects.find(ef => ef.origin === effect.uuid && ef.statuses.has(change.value));
  if (!find()) return;
  try {
    const current = find();
    if (current?.id) await actor.deleteEmbeddedDocuments("ActiveEffect", [current.id]);
  } catch (err) {
    console.warn("dae | removeConditionChange | could not delete condition", change.value, err);
  }
}

export async function addStatusEffectChange(actor: Actor.Implementation, change: ActiveEffect.ChangeData, tokens: foundry.canvas.placeables.Token.Implementation[], sourceEffect: ActiveEffect.Implementation, context: any = {}): Promise<ActiveEffect[] | boolean> {
  if (change.key !== "StatusEffect") return false;
  if (change.value.startsWith("zce-")) {
    const effectId = change.value.replace("zce-", "ce-")
    const effect = ceInterface?.findEffect && ceInterface.findEffect({ effectId });
    if (effect) {
      return await ceInterface!.addEffect({ effectId, uuid: actor.uuid, origin: sourceEffect.uuid, overlay: false });
    }
  } else {
    let statusEffect: any = getStatusEffectsArray().find(se => se.id === change.value);
    if (statusEffect) {
      return toggleActorStatusEffect(actor, statusEffect.id, { active: true, origin: sourceEffect.uuid });
    }
  }
  return false;
}

export async function removeStatusEffectChange(actor: Actor.Implementation, change: ActiveEffect.ChangeData, tokens: foundry.canvas.placeables.Token.Implementation[], effect: ActiveEffect.Implementation, context: any = {}) {
  // TODO this might remove too many effects
  const effectsToRemove = actor.effects.filter(ef => ef.origin === effect.uuid)?.map(ef => ef.id!);
  if (effectsToRemove && effectsToRemove.length > 0)
    await actor.deleteEmbeddedDocuments("ActiveEffect", effectsToRemove, context);
}

export async function expireEffects(actor: Actor.Implementation, effects: ActiveEffect.Implementation[], context: any): Promise<any> {
  if (!effects) return {};
  const actorEffectsToExpire: string[] = [];
  const effectsToDelete: ActiveEffect.Implementation[] = [];
  const effectsToDisable: ActiveEffect.Implementation[] = [];
  for (let effect of effects) {
    if (!effect.id) continue;
    if (!fromUuidSync(effect.uuid)) continue;
    if (effect.transfer)
      effectsToDisable.push(effect);
    else if (effect.parent instanceof Actor)
      actorEffectsToExpire.push(effect.id);
    else if (effect.parent instanceof Item) // this should be enchantments
      effectsToDelete.push(effect);
  }
  if (actorEffectsToExpire.length > 0) {
    const toDelete: string[] = [];
    const toSuppress: string[] = [];
    for (const id of actorEffectsToExpire) {
      const ef = actor.effects.get(id);
      if (!ef) continue;
      if (resolveEffectExpiryAction(ef) === "delete") toDelete.push(id);
      else toSuppress.push(id);
    }
    if (toDelete.length > 0) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", toDelete, context);
    }
    if (toSuppress.length > 0) {
      // Suppress by disabling; see expireEffect for why duration.expired cannot mean "keep".
      const updates = toSuppress.map(id => ({ _id: id, "disabled": true, "duration.expired": false }));
      await actor.updateEmbeddedDocuments("ActiveEffect", updates, context);
    }
  }
  if (effectsToDisable.length > 0) {
    for (let effect of effectsToDisable) {
      await effect.update({ "disabled": true }, context)
    }
  }
  if (effectsToDelete.length > 0) {
    for (let effect of effectsToDelete)
      await effect.delete(context);
  }
  return { expired: actorEffectsToExpire, disabled: effectsToDisable, itemEffects: effectsToDelete };
}

function createActiveEffectHook(effect: ActiveEffect.Implementation, options: ActiveEffect.Database.CreateOptions, userId: string) {
  if (userId !== game.user?.id) return true;
  // @ts-expect-error Can this happen?
  if (options.isUndo) return true;
  if (!effect.parent) return true;
  let actor = effect.parent;
  if (actor instanceof CONFIG.Item.documentClass) {
    if (!effect.transfer) return true; // non-transfer effects on items should not be applied to the actor
    actor = effect.parent.parent as Actor.Implementation;
  }
  if (!actor) {
    // not an effect on an actor so do nothing
    return true;
  }
  const tokens = actor.isToken ? [actor.token?.object] : actor.getActiveTokens();
  if (!(tokens[0] instanceof foundry.canvas.placeables.Token)) return;
  const token: foundry.canvas.placeables.Token.Implementation = tokens[0];
  // @ts-expect-error v14 effect.system.changes
  if (effect.system?.changes?.length && effect.active) {
    // don't apply macro or macro like effects if active aura and not targeting self
    if (!isSelfAuraChange(effect, actor)) {
      // @ts-expect-error v14 effect.system.changes
      actionQueue.add(processEffectChanges, "on", actor, tokens, effect, undefined, effect.system.changes, options)
        .catch(err => {
          const message = "dae | createActiveEffectHook | create effect error";
          if (globalThis.MidiQOL?.apps?.TroubleShooter) {
            globalThis.MidiQOL.apps.TroubleShooter.recordError(err, message);
          }
          console.warn(message, err);
        });
    }
  }
  return true;
}

async function _preCreateActiveEffectRemoveExisting(this: ActiveEffect.Implementation, effectData: ActiveEffect.CreateData, options: ActiveEffect.Database.PreCreateOptions, user: User.Implementation) {
  if (debugEnabled > 0) warn("preCreateActiveEffectRemoveExisting", effectData, options, user);
  let result = true;
  try {
    // @ts-expect-error Can this happen?
    options.deleted = false;
    result = await handleExistingEffects(this, options);
  } catch (err) {
    error("removeExistingEffects ", err);
    result = true;
  } finally {
    return result;
  }
}

async function _preCreateActiveEffectIncrement(data: ActiveEffect.CreateData, options: ActiveEffect.Database.PreCreateOptions, user: User.Implementation) {
  if (debugEnabled > 0)
    warn("_preCreateActiveEffect", this, data, options, user);
  // Make changes to the effect data as needed
  let result = true;
  try {
    // @ts-expect-error Can this happen?
    if (options.isUndo)
      return result = true;
    const parent = this.parent;
    if (!(parent instanceof CONFIG.Actor.documentClass))
      return result = true;
    if (!this.flags?.dae?.specialDuration) {
      this.updateSource({ "flags.dae.specialDuration": [] });
      foundry.utils.setProperty(data, "flags.dae.specialDuration", []);
    }

    if (parent instanceof Actor) {
      // Handle count/countDeleteDecrement stacking
      const shouldCreate = await handleStackIncrement(this, data, options);
      if (!shouldCreate) return result = false;

      // Prevent duplicate status effects
      if (getStatusEffectsArray().find(se => se._id === this.id) && parent.effects.find(ef => ef.id === this._id)) {
        console.warn(`dae | Attempting to add ${this.id} when already present - ignoring`);
        return result = false;
      }
      let updates = {};

      // Update the duration on the effect if needed
      if (this.flags?.dae?.durationExpression && parent instanceof Actor) {
        let sourceActor = parent;
        if (!data.transfer) { // for non-transfer effects we might be pointing to a different actor
          const thing = fromUuidSync(this.origin) as Item.Implementation;
          if (thing?.actor) sourceActor = thing.actor;
        }
        let theDurationRoll = new Roll(`${this.flags.dae.durationExpression}`, sourceActor?.getRollData() as AnyObject);
        let theDuration = await theDurationRoll.evaluate();
        updates["duration.value"] = theDuration.total;
      }
      let changesChanged = false;
      let newChanges: any = [];
      debug("dae _preCreate changes input:", JSON.stringify(this.system.changes.map(c => ({key: c.key, value: c.value}))));
      for (let change of this.system.changes) {
        const converted = convertChangeValue(change, `${this.name} (${this.uuid})`);
        if (converted !== change.value) {
          change.value = converted;
          changesChanged = true;
        }
        if (typeof change.value === "string") {
          const token = getSelfTarget(parent);
          const tokenUuid = token instanceof TokenDocument ? token.uuid : token.document.uuid;
          const context = {
            "@actorUuid": parent?.uuid,
            "@tokenUuid": tokenUuid,
            "@targetUuid": tokenUuid
          };
          for (let key of Object.keys(context)) {
            // Can't do a Roll.replaceFormula because of non-matches being replaced.
            let newValue: any;
            if (change.value.includes(`@${key}`))
              continue;
            newValue = change.value.replaceAll(key, context[key]);
            if (newValue !== change.value) {
              changesChanged = true;
              change.value = newValue;
            }
          }
        }
        const isStatusEffect = change.key === "StatusEffect";
        if (isStatusEffect) console.warn("ActiveEffect | StatusEffect change key is deprecated, use macro.StatusEffect instead");
        else if (change.key.startsWith("macro.itemMacro")) {
          const item = fromUuidSync(this.origin);
          if (item instanceof Item) foundry.utils.setProperty(updates, `flags.dae.itemMacro`, getItemMacroCommand(item));
        }
        if (!isStatusEffect && hasInlineRoll(change.value)) {
          const newChange: any = foundry.utils.duplicate(change);
          changesChanged = true;
          newChange.value = await rollInline(change.value, parent, this.name);
          newChanges.push(newChange);
        } else newChanges.push(change);
      }
      if (changesChanged)
        updates["system.changes"] = newChanges;
      debug("dae _preCreate changes output:", JSON.stringify(newChanges.map(c => ({key: c.key, value: c.value}))), "changesChanged:", changesChanged);
      this.updateSource(updates);
    }
  }
  catch (err) {
    console.error("dae | _preCreateActiveEffect", err);
  }
  finally {
    return result;
  }
}
function recordDisabledSuppressedHook(effect: ActiveEffect.Implementation, updates: ActiveEffect.UpdateData, options: ActiveEffect.Database.PreUpdateOptions, userId: string) {
  // @ts-expect-error v14 effect.system.changes
  foundry.utils.setProperty(options, "dae.active", { wasDisabled: effect.disabled, wasSuppressed: effect.isSuppressed, oldChanges: foundry.utils.duplicate(effect.system.changes) });
  return true;
}

/**
 * Dependent effects (e.g. of concentration) are disabled while their parent is disabled or suppressed.
 * Those this user cannot update, such as a player's concentration dependents on enemies, are left to the GM.
 */
export async function syncDependents(effect: ActiveEffect.Implementation): Promise<void> {
  const disabled = effect.disabled || effect.isSuppressed;
  let forGM = false;
  // @ts-expect-error no dnd5e-types
  for (const dependent of effect.getDependents()) {
    if (dependent.disabled === undefined || dependent.disabled === disabled) continue;
    if (dependent.canUserModify(game.user, "update")) await dependent.update({ disabled });
    else forGM = true;
  }
  if (forGM && !game.user?.isGM) await socketlibSocket.executeAsGM("syncDependents", { uuid: effect.uuid });
}

export function updateActiveEffectHook(
  effect: ActiveEffect.Implementation,
  updates: ActiveEffect.UpdateData,
  options: ActiveEffect.Database.PreUpdateOptions & {
    dae?: {
      active?: {
        wasDisabled?: boolean;
        wasSuppressed?: boolean;
      }
    },
    effectUuid?: string;
  },
  userId: string
) {
  let result = true;
  // @ts-expect-error Can this happen?
  if (options.isUndo) return result = true;
  if (userId !== game.user?.id) return result = true;
  const parent = effect.parent;
  if (!parent) return true;
  // if ((foundry.utils.getProperty(updates, "flags.dae.itemsToDelete") ?? []).length > 0) return true;
  let actor: Actor.Implementation | null | undefined;

  if (parent instanceof CONFIG.Item.documentClass) {
    if (!effect.transfer) return;
    // Suppressed effects are covered by the item update
    actor = parent.parent;
    if (actor instanceof CONFIG.Actor.documentClass) {
      // if disabled status changed remove dependent effects macro.execute, createItem etc
      const wasDisabled = options.dae?.active?.wasDisabled ?? false;
      const becameDisabled = effect.disabled && !(options.dae?.active?.wasDisabled ?? false);
      const becameEnabled = (options.dae?.active?.wasDisabled ?? false) && !(effect.disabled ?? false);
      const item = effect.parent;
      if (becameDisabled) {
        // @ts-expect-error v14 effect.system.changes
        for (let change of effect.system.changes) {
          removeEffectChange(actor, [], effect, item as Item.Implementation, change, options)
        }
      } else if (becameEnabled) {
        // @ts-expect-error v14 effect.system.changes
        for (let change of effect.system.changes) {
          addEffectChange(actor, [], effect, item as Item.Implementation, change, options)
        }
      }
      return true;
    }
  }
  if (parent instanceof Actor) actor = parent;
  // if (effect.disabled === context.dae?.active?.disabled && effect.isSuppressed === context.dae?.active?.isSuppressed) return true;
  if (!actor) return true;
  syncDependents(effect).catch(err => console.warn("dae | syncing dependents error", err));
  actionQueue.add(async () => {
    if (!actor) return;
    const tokens = actor.isToken ? [actor.token?.object] : actor.getActiveTokens();
    const token = tokens[0];
    if (!(token instanceof foundry.canvas.placeables.Token)) return;
    warn("add active effect actions", actor, updates)

    let addedChanges: ActiveEffect.ChangeData[] = [];
    let removedChanges: ActiveEffect.ChangeData[] = [];
    let existingChanges: ActiveEffect.ChangeData[] = [];
    let oldChanges: ActiveEffect.ChangeData[] = [];
    let newChanges: ActiveEffect.ChangeData[] = [];
    // @ts-expect-error v14 updates.system?.changes
    if (updates.system?.changes) {
      oldChanges = ((foundry.utils.getProperty(options, "dae.active.oldChanges") as ActiveEffect.ChangeData[]) ?? []).sort((a, b) => a.key < b.key ? -1 : 1);
      // @ts-expect-error v14 effect.system.changes
      newChanges = effect.system.changes.filter(c => c.key && c.key !== "").sort((a, b) => a.key < b.key ? -1 : 1);
      // @ts-expect-error v14 change.type replaces change.mode
      removedChanges = oldChanges.filter(change => !newChanges.some(c => c.key === change.key && c.type === change.type && c.value === change.value));
      // @ts-expect-error v14 change.type replaces change.mode
      existingChanges = oldChanges.filter(change => newChanges.some(c => c.key === change.key && c.type === change.type && c.value === change.value));
      // @ts-expect-error v14 change.type replaces change.mode
      addedChanges = newChanges.filter(change => !oldChanges.some(c => c.key === change.key && c.type === change.type && c.value === change.value));
      if (debugEnabled > 0) {
        warn("updateActiveEffect hook | old changes", oldChanges);
        warn("updateActiveEffect hook | new changes", newChanges);
        warn("updateActiveEffect hook | removed Changes ", removedChanges);
        warn("updateActiveEffect hook | added changes ", addedChanges);
        warn("updateActiveEffect hook | existing changes", existingChanges);
      }
    // @ts-expect-error v14 effect.system.changes
    } else existingChanges = effect.system.changes;
    const wasDisabled = options.dae?.active?.wasDisabled ?? false;
    const wasSuppressed = options.dae?.active?.wasSuppressed ?? false;
    const becameDisabled = effect.disabled && !(options.dae?.active?.wasDisabled ?? false);
    const becameSuppressed = effect.isSuppressed && !(options.dae?.active?.wasSuppressed ?? false);
    if (becameSuppressed || becameDisabled || removedChanges.length > 0) {
      let changesToDisable: ActiveEffect.ChangeData[] = [];
      if (becameSuppressed || becameDisabled) {
        changesToDisable = existingChanges.concat(removedChanges);
      } else if (!wasDisabled && !wasSuppressed) {
        changesToDisable = removedChanges;
      }
      if (changesToDisable.length > 0) {
        const disableContext: any = { ...options };
        // an expiry that disabled or suppressed the effect keeps its own reason, as a deletion does
        disableContext["expiry-reason"] ??= becameDisabled ? "effect-disabled" : becameSuppressed ? "effect-suppressed" : "change-deleted";
        await processEffectChanges("off", actor, tokens, effect, undefined, changesToDisable, disableContext);
      }
    }

    const becameEnabled = (options.dae?.active?.wasDisabled ?? false) && !(effect.disabled ?? false);
    const becameUnsuppressed = (options.dae?.active?.wasSuppressed ?? false) && !(effect.isSuppressed ?? false);
    if (becameEnabled || becameUnsuppressed || addedChanges.length > 0) {
      let changesToEnable: ActiveEffect.ChangeData[] = [];
      if (becameEnabled || becameUnsuppressed) {
        changesToEnable = existingChanges.concat(addedChanges);
      } else if (!effect.disabled && !effect.isSuppressed) {
        changesToEnable = addedChanges;
      }
      if (changesToEnable.length > 0) {
        await processEffectChanges("on", actor, tokens, effect, undefined, changesToEnable, options);
      }
    }
  }).catch(err => {
    console.warn("dae | updating active effect error", err);
  });

  return result = true;
}


async function _preDeleteActiveEffectDecrement(
  this: ActiveEffect.Implementation,
  options: ActiveEffect.Database.PreDeleteOptions & {
    removeStacks?: number;
  },
  user: User.Implementation
) {
  if (!options.removeStacks)
    options.removeStacks = 1;
  if (this.flags.dae?.stackable === "count")
    options.removeStacks = Math.max(1, this.flags.dae.stacks ?? 1);
  // @ts-expect-error Can this happen?
  if (options.forceDelete || !(this.parent instanceof Actor))
    return true;
  const stacks = Math.max(0, this.flags?.dae?.stacks ?? 1);
  const newStacks = Math.max(1, stacks - options.removeStacks);
  if (stacks <= options.removeStacks) {
    options.removeStacks = Math.max(1, stacks);
    return true;
  }
  foundry.utils.setProperty(this, "flags.dae.stacks", newStacks);
  await this.update({
    name: `${effectBaseName(this)} (${newStacks})`,
    flags: {
      dae: {
        stacks: newStacks
      }
    }
  });
  // const counter = globalThis.EffectCounter?.findCounter(getTokenDocument(this.parent), this.img ?? this.icon);
  // await counter?.setValue(newStacks);
  debug("decrementing complete", this.name, stacks);
  // @ts-expect-error no dnd5e-types
  const dependents = this.getDependents();
  if (dependents)
    for (let dependent of dependents) {
      if (fromUuidSync(dependent.uuid))
        await dependent.delete(options);
    }
  return false;
}

export function deleteActiveEffectHook(effect: ActiveEffect.Implementation, options: ActiveEffect.Database.DeleteOptions, userId: string) {
  if (game.user?.id !== userId) return true;
  // @ts-expect-error Can this happen?
  if (options.isUndo) return true;
  if (!effect.parent) return true;
  let actor: Actor.Implementation | null | undefined;
  if (effect.parent instanceof CONFIG.Actor.documentClass) actor = effect.parent;
  else if (effect.parent instanceof CONFIG.Item.documentClass && effect.transfer) actor = effect.parent.parent;
  if (!actor) return true;

  // @ts-expect-error v14 effect.system.changes
  if (effect.system?.changes) {
    // @ts-expect-error Is this okay?
    options.effectDeleted = true;
    if (!foundry.utils.getProperty(options, "expiry-reason")) foundry.utils.setProperty(options, "expiry-reason", "effect-deleted");
    actionQueue.add(async () => {
      if (!actor) return;
      // @ts-expect-error v14 effect.system.changes
      const changes: ActiveEffect.ChangeData[] = effect.system.changes;
      // Process standard change types and macro changes via processEffectChanges
      await processEffectChanges("off", actor,
        actor.token ? [actor.token.object] : actor.getActiveTokens(),
        effect, undefined, changes, options);
      // Handle special delete-only change keys not covered by processEffectChanges
      let entityToDelete: string | null | undefined;
      for (const change of changes) {
        try {
          if (change.key === "flags.dae.deleteUuid" && change.value) {
            await socketlibSocket.executeAsGM("deleteUuid", { uuid: change.value });
          }
          if (change.key === "flags.dae.suspendActiveEffect" && change.value) {
            await socketlibSocket.executeAsGM("suspendActiveEffect", { uuid: change.value });
          }
          if (change.key === "flags.dae.deleteOrigin") entityToDelete = effect.origin;
          if (entityToDelete) await socketlibSocket.executeAsGM("deleteUuid", { uuid: entityToDelete });
        } catch (err) {
          console.warn("dae | error deleting active effect ", effect, err);
        }
      }
      if (effect.origin) {
        let origin: any = await fromUuid(effect.origin);
        if (globalThis.Sequencer && (origin === actor || origin?.parent === actor))
          globalThis.Sequencer.EffectManager.endEffects({ origin: effect.origin });
      }
    }).catch(err => {
      console.warn("dae | deleteActiveEffectHook error", err);
    });
  }
  return true;
}

export function getSelfTarget(actor: Actor.Implementation | null): Token | TokenDocument {
  // An undrawn token (another level, a scene not viewed) has no placeable: its document then.
  if (actor?.token) return actor.token.object ?? actor.token;
  const speaker = ChatMessage.getSpeaker({ actor });
  if (speaker.token) {
    const token = canvas?.tokens?.get(speaker.token);
    if (token) return token;
  }
  const tokenData = actor?.prototypeToken.toObject(false);
  return new CONFIG.Token.documentClass(tokenData);
}

export async function daeMacro(action: string, actor: Actor.Implementation, effectData: ActiveEffect.Implementation | ActiveEffect.Source, lastArgOptions: any = {}) {
  let selfTarget: TokenOrDocument | null;
  let macro: Macro.Implementation | undefined;
  let theItem: Item.Implementation | null | undefined;

  if (effectData instanceof ActiveEffect && !lastArgOptions.effectUuid) lastArgOptions.effectUuid = effectData.uuid;
  // Work out what itemData should be
  warn("Dae macro ", action, actor, effectData, lastArgOptions)
  // @ts-expect-error v14 system.changes on toObject() data
  if (!effectData.system?.changes) return effectData;
  if (effectData instanceof ActiveEffect) {
    if (effectData.transfer && effectData.parent instanceof Item) theItem = effectData.parent;
    effectData = effectData.toObject(false);
  }
  if (lastArgOptions.item) theItem = lastArgOptions.item;
  if (!theItem) theItem = await resolveItemFromEffect(effectData, actor);

  let context = actor.getRollData() as AnyMutableObject;
  if (theItem) {
    context.item = theItem;
    context.itemData = theItem.toObject(false);
    if (theItem) foundry.utils.setProperty(effectData, "flags.dae.itemData", theItem.toObject());
  }

  let tokenUuid: string;
  if (actor.token) {
    tokenUuid = actor.token.uuid;
    selfTarget = actor.token.object;
  } else {
    selfTarget = getSelfTarget(actor);
    tokenUuid = selfTarget instanceof TokenDocument ? selfTarget.uuid : selfTarget.document.uuid;
  }
  // @ts-expect-error v14 system.changes on toObject() data
  for (let change of (effectData.system?.changes ?? [])) {
    try {
      if (!allMacroEffects.includes(change.key)) continue;
      context.stackCount = effectData.flags?.dae?.stacks ?? 1;
      let functionMatch;
      if (typeof change.value === "string") change.value = change.value.trim();
      if (change.value.startsWith("function.")) {
        const paramRe = /function\.\w+(\.\w+)*\("[^"]*"(?:\s*,\s*"[^"]*")+?\)/;
        const paramMatch = change.value.match(paramRe);
        if (paramMatch) functionMatch = paramMatch[0];
        else functionMatch = change.value.split(" ")[0];
        functionMatch = functionMatch.replace("function.", "");
        if (change.key.includes("macro.execute"))
          change.value = change.value.replace(functionMatch, "FunctionMatch");
      }
      const theChange = await evalArgs({ item: theItem, effectData, context, actor, change, doRolls: true })
      let args: any[] = [];
      let v11args: any = {};
      if (typeof theChange.value === "string") {
        tokenizer.tokenize(theChange.value, (token: any) => args.push(token));
        if (theItem) args = args.map(arg => {
          if ("@itemData" === arg) {
            return theItem.toObject(false);
          } else if ("@item" === arg) {
            return theItem;
          }
          if (typeof arg === "string") {
            const splitArg = arg.split("=");
            if (splitArg.length === 2) {
              if (splitArg[1] === "@itemData") {
                const itemData = theItem?.toObject(false);
                v11args[splitArg[0]] = itemData
                return itemData;
              } else if (splitArg[1] === "@item") {
                v11args[splitArg[0]] = theItem;
                return theItem;
              } else v11args[splitArg[0]] = splitArg[1];
            }
          }
          return arg;
        })
      } else args = [change.value];
      if (theChange.key.includes("macro.execute") || theChange.key.includes("macro.itemMacro") || change.key.startsWith("macro.activityMacro")) {
        if (functionMatch) {
          macro = createFunctionMacro(functionMatch);
        } else macro = await resolveMacro(change.key, args[0], theItem, effectData, lastArgOptions.effectUuid);
        if (!macro) {
          //TODO localize this
          if (action !== "off") {
            ui.notifications?.warn(`macro.execute/macro.itemMacro | No macro ${args[0]} found`)
            warn(`macro.execute/macro.itemMacro | No macro ${args[0]} found`);
            continue;
          }
        }
        // doing this refetch to try and make sure the actor has not been deleted
        if (!fromUuidSync(actor.uuid)) {
          error("actor vanished", actor.name, actor.uuid);
          return;
        }
        const activityUuid = effectData.flags?.dae?.activity;
        let lastArg = foundry.utils.mergeObject(lastArgOptions, {
          effectId: effectData._id,
          origin: effectData.origin,
          activity: activityUuid,
          efData: effectData,
          actorId: actor.id,
          actorUuid: actor.uuid,
          tokenId: selfTarget?.id,
          effectUuid: lastArgOptions.effectUuid,
          tokenUuid,
        }, { overwrite: false, insertKeys: true, insertValues: true, inplace: false });
        if (theChange.key.includes("macro.execute"))
          args = args.slice(1);
        let macroArgs: any[] = [action];
        macroArgs = macroArgs.concat(args).concat(lastArg);
        const macroActivity = await fromUuid(activityUuid);
        const effect = fromUuidSync(lastArgOptions.effectUuid) as ActiveEffect.Implementation;
        const scope: Macro.ExecuteScope<"script"> = {
          actor,
          token: selfTarget instanceof TokenDocument ? selfTarget.object : selfTarget,
          lastArgValue: lastArg,
          item: theItem,
          macroItem: theItem,
          macroActivity,
          effect
        };

        scope.args = macroArgs.filter(arg => {
          if (typeof arg === "string") {
            const parts = arg.split("=");
            if (parts.length === 2) {
              scope[parts[0]] = parts[1];
              return false;
            }
          }
          return true;
        })

        await macro?.execute(scope);

      } else if (theChange.key === "macro.actorUpdate") {
        let lastArg = foundry.utils.mergeObject(lastArgOptions, {
          effectId: effectData._id,
          origin: effectData.origin,
          efData: effectData,
          actorId: actor.id,
          actorUuid: actor.uuid,
          tokenId: selfTarget?.id,
          tokenUuid,
        }, { overwrite: false, insertKeys: true, insertValues: true, inplace: false });

        // try and make sure the actor has not vanished
        if (!fromUuidSync(actor.uuid)) {
          error("actor vanished", actor.name, actor.uuid);
        }
        await macroActorUpdate(action, ...args, lastArg);
        // result = await macroActorUpdate(action, ...args, lastArg);
      }
    } catch (err) {
      const message = `daeMacro | "${action}" macro "${macro?.name}" for actor ${actor?.name} in ${theItem ? "item " + theItem.name : ""} ${actor?.uuid} ${theItem?.uuid}`;
      console.warn(message, err);
      if (globalThis.MidiQOL?.apps?.TroubleShooter)
        globalThis.MidiQOL.apps.TroubleShooter.recordError(err, message);
    }
  };
  return effectData;
}

export async function evalArgs({
  effectData,
  item,
  context,
  actor,
  change,
  spellLevel = undefined,
  damageTotal = 0,
  doRolls = false,
  critical = false,
  fumble = false,
  whisper = false,
  itemCardUuid = null,
  tokenUuid = null
}: EvalArgsInput) {
  const itemUuid = item?.uuid ?? effectData.flags?.dae?.itemUuid;
  if (!item && itemUuid) item = await fromUuid(itemUuid) as Item.Implementation;
  if (typeof change.value !== 'string')
    return change; // nothing to do
  const returnChange = foundry.utils.duplicate(change) as ActiveEffect.ChangeData;
  // @ts-expect-error context isn't typed
  spellLevel ??= context.flags?.dnd5e?.spellLevel;
  let contextToUse = foundry.utils.mergeObject({
    scene: canvas?.scene?.id,
    token: ChatMessage.getSpeaker({ actor }).token,
    target: "@target",
    targetUuid: "@targetUuid",
    targetActorUuid: "@targetActorUuid",
    spellLevel,
    itemLevel: spellLevel,
    damage: damageTotal,
    itemCardUuid: itemCardUuid,
    unique: foundry.utils.randomID(),
    actor: actor.id,
    actorUuid: actor.uuid,
    critical,
    fumble,
    whisper,
    change: JSON.stringify(change),
    itemId: item?.id,
    itemUuid: item?.uuid,
    tokenUuid
  }, context, { overwrite: true });
  //contextToUse["item"] = "@item";
  if (item) {
    foundry.utils.setProperty(effectData, "flags.dae.itemUuid", item.uuid);
    foundry.utils.setProperty(effectData, "flags.dae.itemData", item.toObject(false));
    contextToUse["itemData"] = "@itemData";
    contextToUse["item"] = item.getRollData()?.item;
  } else {
    contextToUse["itemData"] = "@itemData";
    contextToUse["item"] = "@item";
  }
  returnChange.value = returnChange.value.replace("@item.level", "@itemLevel")
  returnChange.value = returnChange.value.replace(/@data./g, "@");
  // A document link is not a data path; deferred like ##, so it is restored below rather than replaced with 0.
  returnChange.value = returnChange.value.replaceAll("@UUID", "##UUID").replaceAll("@uuid", "##uuid");
  const returnChangeValue = Roll.replaceFormulaData(returnChange.value, contextToUse, { missing: "0", warn: false });
  if (typeof returnChange.value === "object") {
    console.error("object returned from replaceFormula Data", returnChange.value);
  } else {
    returnChange.value = returnChangeValue;
  }
  returnChange.value = returnChange.value.replaceAll("##", "@");
  if (typeof returnChange.value === "string" && !returnChange.value.includes("[[")) {
    switch (change.key) {
      case "macro.itemMacro":
      case "macro.itemMacro.local":
      case "macro.itemMacro.GM":
      case "macro.execute":
      case "macro.execute.local":
      case "macro.execute.GM":
      case "macro.actorUpdate":
      case "macro.activityMacro":
        break;
      case "macro.CE":
      case "macro.StatusEffect":
      case "StatusEffect":
      case "macro.tokenMagic":
      case "macro.createItem":
      case "macro.createItemRunMacro":
      case "macro.summonToken":
        break;
      default:
        const currentValue = foundry.utils.getProperty(actor, change.key);
        if (doRolls && typeof (currentValue ?? ValidSpec.actorSpecs[actor.type].allSpecsObj[change.key]?.fieldType) === "number") {
          const roll = new Roll(returnChange.value, contextToUse);
          if (!roll.isDeterministic) {
            error("evalArgs: expression is not deterministic dice terms ignored", actor.name, actor.uuid, returnChange.value);
            returnChange.value = String(roll.evaluateSync({ strict: false }).total);
          }
        };
        break;
    };
    debug("evalargs: change is ", returnChange);
  }
  return returnChange;
}

/*
 * apply non-transfer effects to target tokens - provided for backwards compat
 */
export async function doEffects(
  item: Item.Implementation,
  activate: boolean,
  targets: DoEffectsTargets = undefined,
  options: DoEffectsOptions
) {
  return await applyNonTransferEffects(item, activate, targets, options)
}

export async function doActivityEffects(
  activity,
  activate: boolean,
  targets: DoEffectsTargets = undefined,
  activityEffectsUuids: string[],
  options: DoEffectsOptions
) {
  const activityEffects = (activityEffectsUuids.map(aeUuid => fromUuidSync(aeUuid) ?? activity.effects.find(ae => ae.effect.uuid === aeUuid)?.effect) as ActiveEffect.Implementation[]).filter(ef => ef).map(ef => ef.toObject());
  // TODO dnd5e v4 - a temporary fix to make sure the effects are not disabled when applied
  activityEffects.forEach(ef => ef.disabled = false);
  return await applyActivityEffects(activity, activate, targets, activityEffects, options)
}

export async function applyActivityEffects(
  activity,
  activate: boolean,
  targets: DoEffectsTargets,
  activityEffects: ActiveEffect.Source[],
  options: DoEffectsOptions = {
    context: {},
    critical: false,
    damageTotal: null,
    effectsToApply: [],
    fumble: false,
    itemCardUuid: null,
    origin: activity.item.uuid,
    removeMatchLabel: false,
    selfEffects: "none",
    spellLevel: 0,
    toggleEffect: false,
    whisper: false,
  }
) {
  if (!options.applyAll)
    activityEffects = activityEffects.filter(aeData => aeData.flags?.dae?.dontApply !== true);
  else
    activityEffects.forEach(aeData => foundry.utils.setProperty(aeData, "flags.dae.dontApply", false));
  if (activityEffects.length === 0) return;
  const rollData = activity.item.getRollData(); //TODO if not caster eval move to evalArgs call
  options.toggleEffect = activity.midiProperties?.toggleEffect || activity.item.flags?.midiProperties?.toggleEffect;

  let macroLocation = "mixed";
  for (let [aeIndex, activeEffectData] of activityEffects.entries()) {
    // @ts-expect-error v14 system.changes on toObject() data
    for (let [changeIndex, change] of activeEffectData.system.changes.entries()) {
      const doRolls = isRegisteredMacroKey(change.key);
      if (doRolls) {
        const dest = getChangeDestination(change.key);
        if (dest === "local" && macroLocation !== "GM") macroLocation = "local";
        else if (dest === "GM") macroLocation = "GM";
      }
      // eval args before calling GMAction so macro arguments are evaled in the casting context.
      // Any @fields for macros are looked up in actor context and left unchanged otherwise
      rollData.stackCount = activeEffectData.flags?.dae?.stacks ?? 1;
      const evalArgsOptions: any = Object.assign({}, options, {
        effectData: activeEffectData,
        change,
        doRolls
      });
      evalArgsOptions.context = { ...rollData, ...(options.context ?? {}) };
      evalArgsOptions.context.activity = activity.getRollData?.() ?? activity;
      evalArgsOptions.item = activity.item;
      if (activity.actor) evalArgsOptions.actor = activity.actor;
      let newChange = await evalArgs(evalArgsOptions)
      // @ts-expect-error v14 system.changes on toObject() data
      activeEffectData.system.changes[changeIndex] = newChange;
    };
    // @ts-expect-error Thinks `uuid` shouldn't exist
    activeEffectData.origin = options.origin ?? activityEffects[aeIndex].uuid;
    daeSystemClass.addDAEMetaData(activeEffectData, activity.item, options)
    activityEffects[aeIndex] = activeEffectData;
  }

  // Split up targets according to whether they are owned on not. Owned targets have effects applied locally, only unowned are passed ot the GM
  let targetList: any[] = Array.from(targets ?? []);
  targetList = targetList.map(t =>
    (typeof t === "string") ? (fromUuidSync(t) as TokenDocument)?.actor : t
  );
  targetList = targetList.map(t => (t instanceof foundry.canvas.placeables.Token) || (t instanceof TokenDocument) ? t.actor : t);
  targetList = targetList.filter(t => t instanceof Actor);
  let localTargets = targetList.filter(t => macroLocation === "local" || (t.isOwner && macroLocation === "mixed")).map(t => t.uuid);
  let gmTargets = targetList.filter(t => (!t.isOwner && macroLocation === "mixed") || macroLocation === "GM").map(t => t.uuid);

  debug("apply non-transfer effects: About to call gmaction ", activate, activityEffects, targets, localTargets, gmTargets)
  if (gmTargets.length > 0) {
    await socketlibSocket.executeAsGM("applyActiveEffects", { userId: game.user?.id, activate, activityUuid: activity.uuid, activeEffects: activityEffects, targetList: gmTargets, effectDuration: activity.duration, itemCardUuid: options.itemCardUuid, removeMatchLabel: options.removeMatchLabel, toggleEffect: options.toggleEffect, metaData: options.metaData })
  }
  if (localTargets.length > 0) {
    const result = await applyActiveEffects({ activate, activityUuid: activity.uuid, targetList: localTargets, activeEffects: activityEffects, effectDuration: activity.duration, itemCardUuid: options.itemCardUuid, removeMatchLabel: !!options.removeMatchLabel, toggleEffect: !!options.toggleEffect, metaData: options.metaData!, origin: options.origin })
  }
}
// Apply non-transfer effects to targets.
// macro arguments are evaluated in the context of the actor applying to the targets
// @target is left unevaluated.
// request is passed to a GM client if the token is not owned
export async function applyNonTransferEffects(
  item: Item.Implementation,
  activate: boolean,
  targets?: DoEffectsTargets,
  options: DoEffectsOptions = {
    critical: false,
    damageTotal: null,
    effectsToApply: [],
    fumble: false,
    itemCardUuid: null,
    removeMatchLabel: false,
    selfEffects: "none",
    spellLevel: 0,
    toggleEffect: false,
    tokenId: undefined,
    whisper: false,
  }
) {
  if (!targets) return;
  let macroLocation = "mixed";
  let appliedEffects = filterEffectsForTargeting(item.effects, options.selfEffects ?? "none");
  if (!options.applyAll)
    appliedEffects = appliedEffects.filter(aeData => aeData.flags?.dae?.dontApply !== true);
  else
    appliedEffects.forEach(aeData => foundry.utils.setProperty(aeData, "flags.dae.dontApply", false));
  if (options.effectsToApply?.length) appliedEffects = appliedEffects.filter(aeData => options.effectsToApply?.includes(aeData._id ?? ""))
  if (appliedEffects.length === 0) return;
  const rollData = item.getRollData() as AnyMutableObject; //TODO if not caster eval move to evalArgs call
  // options.toggleEffect = item.flags?.midiProperties?.toggleEffect === true;

  for (let [aeIndex, activeEffectData] of appliedEffects.entries()) {
    // @ts-expect-error v14 system.changes on toObject() data
    for (let [changeIndex, change] of activeEffectData.system.changes.entries()) {
      const doRolls = isRegisteredMacroKey(change.key);
      if (doRolls) {
        const dest = getChangeDestination(change.key);
        if (dest === "local" && macroLocation !== "GM") macroLocation = "local";
        else if (dest === "GM") macroLocation = "GM";
      }
      // eval args before calling GMAction so macro arguments are evaluated in the casting context.
      // Any @fields for macros are looked up in actor context and left unchanged otherwise
      rollData.stackCount = activeEffectData.flags?.dae?.stacks ?? 1;
      const evalArgsOptions: any = Object.assign({}, options, {
        effectData: activeEffectData,
        change,
        doRolls
      });
      evalArgsOptions.context = { ...rollData, ...(options.context ?? {}) };
      evalArgsOptions.item = item;
      if (item.actor) evalArgsOptions.actor = item.actor;
      let newChange = await evalArgs(evalArgsOptions)
      // @ts-expect-error v14 system.changes on toObject() data
      activeEffectData.system.changes[changeIndex] = newChange;
    };

    activeEffectData.origin = options.origin ?? item.uuid;
    daeSystemClass.addDAEMetaData(activeEffectData, item, options)
    appliedEffects[aeIndex] = activeEffectData;
  }

  // Split up targets according to whether they are owned on not. Owned targets have effects applied locally, only unowned are passed ot the GM
  let targetList = Array.from(targets).map(t =>
    (typeof t === "string")
      ? (fromUuidSync(t) as TokenDocument)?.actor
      : (t instanceof Actor)
        ? t
        : t.actor
  ).filter(t => t instanceof Actor);
  let localTargets = targetList.filter(t => macroLocation === "local" || (t.isOwner && macroLocation === "mixed")).map(t => t.uuid);
  let gmTargets = targetList.filter(t => (!t.isOwner && macroLocation === "mixed") || macroLocation === "GM").map(t => t.uuid);

  debug("apply non-transfer effects: About to call gmaction ", activate, appliedEffects, targets, localTargets, gmTargets)
  if (gmTargets.length > 0) {
    // @ts-expect-error no dnd5e-types
    await socketlibSocket.executeAsGM("applyActiveEffects", { userId: game.user?.id, activate, activeEffects: appliedEffects, targetList: gmTargets, effectDuration: item.system.duration, itemCardUuid: options.itemCardUuid, removeMatchLabel: options.removeMatchLabel, toggleEffect: options.toggleEffect, metaData: options.metaData })
  }
  if (localTargets.length > 0) {
    // @ts-expect-error no dnd5e-types
    await applyActiveEffects({ activate, targetList: localTargets, activeEffects: appliedEffects, effectDuration: item.system.duration, itemCardUuid: options.itemCardUuid, removeMatchLabel: options.removeMatchLabel, toggleEffect: options.toggleEffect, metaData: options.metaData, origin: options.origin })
  }
}

/**
 * Processes all effect changes for a single effect, dispatching to the appropriate
 * async helper for each change type and running daeMacro for macro change keys.
 * This function must be called from within actionQueue to ensure serialization.
 * Inner helpers no longer use actionQueue internally, avoiding deadlock.
 */
export async function processEffectChanges(
  action: "on" | "off",
  actor: Actor.Implementation,
  tokens: (foundry.canvas.placeables.Token | null | undefined)[],
  effect: ActiveEffect.Implementation,
  item: Item.Implementation | undefined,
  changes: ActiveEffect.ChangeData[],
  context: any
): Promise<void> {
  let token: foundry.canvas.placeables.Token | undefined = tokens[0] ?? undefined;
  if (!token) {
    token = getToken(actor);
    tokens = token ? [token] : [];
  }
  if (debugEnabled > 0) warn(`processEffectChanges ${action}`, actor, changes, tokens, effect);

  // Dispatch non-macro changes through the registry
  for (const change of changes) {
    const handler = getChangeHandler(change.key);
    if (handler && !handler.isMacroKey) {
      const handlerCtx: ChangeHandlerContext = { actor, change, effect, token, tokens, context };
      await handler[action](handlerCtx);
    }
  }
  await applyCurrentHp(action, actor, effect, changes, context);
  // Batch macro change keys through daeMacro
  if (changes.some(c => isRegisteredMacroKey(c.key))) {
    if (debugEnabled > 0) warn(`processEffectChanges daeMacro ${action}`, actionQueue.remaining);
    const macroContext: any = { effectUuid: effect.uuid };
    if (item) macroContext.item = item;
    if (action === "off") {
      if (item) macroContext.origin = item.uuid;
      if (context?.["expiry-reason"]) macroContext["expiry-reason"] = context["expiry-reason"];
    }
    await daeMacro(action, actor, effect.toObject(false), macroContext);
  }
}

export function addEffectChange(
  actor: Actor.Implementation,
  tokens: (foundry.canvas.placeables.Token | undefined)[],
  effectToApply: ActiveEffect.Implementation,
  item: Item.Implementation,
  change: ActiveEffect.ChangeData,
  context: Item.Database.UpdateOperation
) {
  if (debugEnabled > 0) warn("addEffectChange ", actor, change, tokens, effectToApply)
  // Queue all changes for this effect through actionQueue for serialization
  actionQueue.add(processEffectChanges, "on", actor, tokens, effectToApply, item, [change], context);
}

export function removeEffectChange(
  actor: Actor.Implementation,
  tokens: foundry.canvas.placeables.Token[],
  effectToApply: ActiveEffect.Implementation,
  item: Item.Implementation,
  change: ActiveEffect.ChangeData,
  context: Item.Database.UpdateOperation
) {
  // Queue all changes for this effect through actionQueue for serialization
  actionQueue.add(processEffectChanges, "off", actor, tokens, effectToApply, item, [change], context);
}
// When an item is created any effects have a source that points to the original item
export async function deleteItemHook(candidateItem: Item.Implementation, options: Item.Database.DeleteOptions, userId: string) {
  if (userId !== game.user?.id) return;
  // @ts-expect-error Can this happen?
  if (options.isUndo) return;
  const actor = candidateItem.parent;
  if (!(actor instanceof Actor)) return;
  const token = tokenForActor(actor);
  // @ts-expect-error Is this okay?
  options.itemDeleted = true;
  for (let effect of candidateItem.effects) {
    if (!effect.transfer) continue;
    if (effect.disabled || effect.isSuppressed) continue;
    if (isSelfAuraChange(effect, actor)) continue;
    // @ts-expect-error v14 effect.system.changes
    await actionQueue.add(processEffectChanges, "off", actor, token ? [token] : [], effect, candidateItem, effect.system.changes, options);
  }
  return;
}
export async function createItemHook(item: Item.Implementation, options: Item.Database.CreateOptions, userId: string) {
  // @ts-expect-error Can this happen?
  if (options.isUndo) return;
  if (userId !== game.user?.id) return;
  const actor = item.parent;
  if (!(actor instanceof Actor)) return;
  const token = tokenForActor(actor);
  for (let effect of item.effects) {
    if (!effect.transfer) continue;
    if (effect.disabled || effect.isSuppressed) continue;
    if (isSelfAuraChange(effect, actor)) continue;
    // @ts-expect-error v14 effect.system.changes
    await actionQueue.add(processEffectChanges, "on", actor, [token], effect, item, effect.system.changes, options);
  }
  return;
}

// Process onUpdateTarget flags
export function preUpdateActorHook(candidate: Actor.Implementation, updates: Actor.UpdateData, options: Actor.Database.UpdateOptions, userId: string) {
  let result = true;
  try {
    // @ts-expect-error Can this happen?
    if (options.onUpdateCalled) return result = true;
    for (let onUpdate of (candidate.flags?.dae?.onUpdateTarget ?? [])) {
      if (onUpdate.macroName.length === 0) continue;
      if (onUpdate.filter.startsWith("data.")) {
        onUpdate.filter = onUpdate.filter.replace("data.", "system.");
      }
      if (foundry.utils.getProperty(updates, onUpdate.filter) === undefined) continue;

      const originObject = fromUuidSync(onUpdate.origin) as (Item.Implementation | ActiveEffect.Implementation);
      const sourceTokenDocument = fromUuidSync(onUpdate.sourceTokenUuid) as TokenDocument | undefined;
      const targetTokenDocument = fromUuidSync(onUpdate.targetTokenUuid) as TokenDocument | undefined;
      const sourceActor = actorFromUuid(onUpdate.sourceActorUuid);
      const sourceToken = sourceTokenDocument?.object;
      const targetActor = targetTokenDocument?.actor;
      const targetToken = targetTokenDocument?.object;
      let originItem: Item.Implementation | undefined = (originObject instanceof Item) ? originObject : undefined;
      if (!originItem && originObject instanceof ActiveEffect) originItem = originObject.parent as Item.Implementation;
      if (!originItem) {
        const theEffect = targetActor?.appliedEffects.find(ef => ef.origin === onUpdate.origin);
        if (theEffect?.flags?.dae?.itemUuid) {
          originItem = fromUuidSync(theEffect.flags.dae.itemUuid) as Item.Implementation;
        }
      }

      let lastArg = {
        tag: "onUpdateTarget",
        effectId: null,
        origin: onUpdate.origin,
        efData: null,
        actorId: targetActor?.id,
        actorUuid: targetActor?.uuid,
        tokenId: targetToken?.id,
        tokenUuid: targetTokenDocument?.uuid,
        actor: candidate,
        updates,
        options,
        user: userId,
        userId,
        sourceActor,
        sourceToken,
        targetActor,
        targetToken,
        originItem,
        macroItem: originItem
      };
      let macroText: string | undefined | null;
      if (onUpdate.macroName.startsWith("ItemMacro")) { // TODO Come back and make sure this is tagged to the effect
        if (onUpdate.macroName === "ItemMacro") {
          macroText = getItemMacroCommand(originItem);
        } else if (onUpdate.macroName.startsWith("ItemMacro.")) {
          let macroObject = sourceActor?.items.getName(onUpdate.macroName.split(".")[1]);
          const originActor = originObject?.parent instanceof Actor ? originObject.parent : originObject?.parent?.parent;
          if (!macroObject) macroObject = originActor?.items.getName(onUpdate.macroName.split(".")[1])
          if (macroObject) macroText = getItemMacroCommand(macroObject);
        }
      } else if (onUpdate.macroName.trim().startsWith("function.")) {
        macroText = `return await ${onUpdate.macroName.trim().replace("function.", "").trim()}(speaker, actor, token, character, scope)`
      } else {
        const theMacro: Macro | undefined = game.macros?.getName(onUpdate.macroName);
        if (!theMacro) {
          console.warn(`dae | onUpdateActor no macro found for actor ${candidate.name} macro ${onUpdate.macroName}`);
          continue;
        }
        if (theMacro?.type === "chat") {
          theMacro.execute(); // use the core foundry processing for chat macros
          continue;
        }
        macroText = theMacro?.command;
      }
      try { // TODO make an actual macro and then call macro.execute....
        const speaker = ChatMessage.getSpeaker({ actor: candidate });
        const args: any[] = ["onUpdateActor"].concat(onUpdate.args);
        args.push(lastArg);
        const character = undefined; // game.user?.character;
        const scope = { args, lastArgValue: lastArg, item: originItem, macroItem: originItem };
        args.forEach(argString => {
          if (typeof argString === "string") {
            const parts = argString.split("=");
            if (parts.length === 2) {
              scope[parts[0]] = parts[1];
            }
          }
        })
        macroText = `try { ${macroText} } catch(err) { console.warn("dae | macro error", err) };`
        const AsyncFunction = (async function () { }).constructor;

        const argNames = Object.keys(scope);
        const argValues = Object.values(scope);
        //@ts-expect-error for some reason
        const fn = new AsyncFunction("speaker", "actor", "token", "character", "item", "macroItem", "scope", ...argNames, macroText)
        fn.call(this, speaker, candidate, targetTokenDocument?.object, character, scope.item, scope.macroItem, scope, ...argValues);
      } catch (err) {
        ui.notifications?.error(`There was an error running your macro. See the console (F12) for details`);
        error("dae | Error evaluating macro for onUpdateActor", err)
      }
    }
  } catch (err) {
    console.error("dae | error in onUpdateTarget", err);
  } finally {
    return result;
    // return wrapped(updates, options, user);
  }
}

export function daeReadyActions() {
  DAEReadyComplete = true;
  // @ts-expect-error no typings for dfreds ce
  ceInterface = game.modules.get("dfreds-convenient-effects")?.active ? game.modules.get("dfreds-convenient-effects").api : undefined;

  ValidSpec.localizeSpecs();
  // initSheetTab();
  if (game.settings.get("dae", "disableEffects")) {
    ui.notifications?.warn("DAE effects disabled no DAE effect processing")
    console.warn("dae disabled - no active effects")
  }
  daeSystemClass.readyActions()

  // Process init macros that were deferred during prepareData before game.ready
  // Pass the live ActiveEffect (not .toObject()) so daeMacro resolves theItem
  // from effect.parent (the owned item) rather than following origin to a compendium.
  if (pendingInitMacroEffects.length > 0) {
    for (const { effectUuid, actorUuid } of pendingInitMacroEffects) {
      const effect = fromUuidSync(effectUuid) as ActiveEffect.Implementation | null;
      const actor = fromUuidSync(actorUuid) as Actor.Implementation | null;
      if (!effect || !actor) continue;
      actionQueue.add(daeMacro, "init", actor, effect, { effectUuid });
    }
    pendingInitMacroEffects.length = 0;
  }

  aboutTimeInstalled = game.modules.get("about-time")?.active ?? false;
  simpleCalendarInstalled = game.modules.get("foundryvtt-simple-calendar")?.active ?? false;

  // Provide human-readable labels for module flags (midi-qol, etc.) to dnd5e's
  // effect change display (PR #6820). Falls back to DAE's localizationMap which
  // modules populate via the DAE API.
  Hooks.on("dnd5e.getUnknownAttributeLabel", (attr: string, options: { label?: string }) => {
    const entry = localizationMap[attr];
    if (entry?.name) options.label = entry.name;
  });
}

export let tokenizer: any;

Hooks.on("spotlightOmnisearch.indexBuilt", async (index) => {
  const fieldData: any = await foundry.utils.fetchJsonWithTimeout('modules/dae/data/field-data.json');
  const entries = Object.entries(fieldData).flatMap(([category, fields]: [string, any]) =>
    Object.entries(fields).map(([key, { name, description }]: [string, any]) => ({
      key,
      name,
      description,
      category
    }))
  );
  for (let entry of entries) {
    // @ts-expect-error no typings for spotlight omnisearch
    index.push(new CONFIG.SpotlightOmnisearch.SearchTerm({
      icon: ["fas fa-heart"],
      dragData: { fieldName: entry.key },
      name: entry.key,
      description: entry.description,
      query: "",
      keywords: ["dae", entry.category],
      type: "DAE attributes"
    }));
  }
})

export function daeInitActions() {
  atlActive = game.modules.get("ATL")?.active ?? false;
  midiActive = game.modules.get("midi-qol")?.active ?? false;
  const dnd5System = DAESystemDND5E; // force reference so they are installed?
  libWrapper = globalThis.libWrapper;
  daeSystemClass = foundry.utils.getProperty(globalThis.daeSystems, game.system.id ?? "") as typeof DAESystem;
  daeSystemClass ??= CONFIG.DAE.systemClass;

  daeSystemClass.initActions();
  daeSystemClass.initSystemData();

  // Patch Roll.replaceFormulaData for limited recursion of nested formula references
  libWrapper.register("dae", "Roll.replaceFormulaData", replaceFormulaData, "MIXED");

  if (game.settings.get("dae", "disableEffects")) {
    ui.notifications?.warn("DAE effects disabled no DAE effect processing")
    console.warn("dae | All active effects disabled.")
    return;
  }

  // Augment actor getRollData with actorUuid, actorId, tokenId, tokenUuid
  if (daeSystemClass.getRollDataWrapper) {
    libWrapper.register("dae", "CONFIG.Actor.documentClass.prototype.getRollData", daeSystemClass.getRollDataWrapper, "MIXED");
  }

  Hooks.on("createItem", createItemHook);
  Hooks.on("deleteItem", deleteItemHook);

  // process onUpdateTarget flags
  Hooks.on("preUpdateActor", preUpdateActorHook);

  // Hooks for conditional effects — route through actionQueue to prevent race conditions
  // during bulk imports (e.g., DDB-importer) where many hooks fire concurrently
  Hooks.on("updateActor", scheduleConditionalEffects)
  Hooks.on("updateToken", (tokenDocument, updates) => {
    if (updates.x || updates.y)
      scheduleConditionalEffects(tokenDocument.actor!, updates);
  });
  Hooks.on("updateItem", (item, updates) => {
    if (item.parent instanceof Actor) scheduleConditionalEffects(item.parent, updates)
  });

  Hooks.on("createActiveEffect", (effect, options, userId) => {
    if (game.user !== game.users?.activeGM) return;
    if (effect.parent instanceof Actor) {
      scheduleConditionalEffects(effect.parent, {});
    } else if (effect.transfer) {
      const item = effect.parent;
      const actor = item?.parent;
      if (actor) scheduleConditionalEffects(actor, {});
    }
  });

  Hooks.on("updateActiveEffect", (effect, updates) => {
    if (game.user !== game.users?.activeGM) return;
    if (effect.parent instanceof Actor) {
      scheduleConditionalEffects(effect.parent, updates);
    } else if (effect.transfer) {
      const item = effect.parent;
      const actor = item?.parent;
      if (actor) scheduleConditionalEffects(actor, updates);
    }
  })

  Hooks.on("deleteActiveEffect", (effect) => {
    if (game.user !== game.users?.activeGM) return;
    if (effect.parent instanceof Actor) {
      scheduleConditionalEffects(effect.parent, {});
    } else if (effect.transfer) {
      const item = effect.parent;
      const actor = item?.parent;
      if (actor) scheduleConditionalEffects(actor, {});
    }
  })
  libWrapper.register("dae", "CONFIG.ActiveEffect.documentClass.prototype._preCreate", _preCreateActiveEffect, "MIXED");
  async function _preCreateActiveEffect(this: ActiveEffect, wrapped, data, context, user) {
    // Migrate deprecated flags.dae.showIcon to native showIcon field
    if (this.flags?.dae?.showIcon) {
      // @ts-expect-error showIcon not in fvtt-types
      this.updateSource({ showIcon: 2, "flags.dae.showIcon": new foundry.data.operators.ForcedDeletion() });
      foundry.utils.logCompatibilityWarning(
        `dae | Effect "${this.name}": flags.dae.showIcon is deprecated, auto-migrated to ActiveEffect.showIcon.`,
        { once: true, stack: false }
      );
    }
    // A boolean stackable is DAE's original checkbox: false did not stack by origin ("none"), true stacked ("multi").
    const stackable: unknown = this.flags?.dae?.stackable;
    if (typeof stackable === "boolean") {
      this.updateSource({ flags: { dae: { stackable: stackable ? "multi" : "none" } } });
      foundry.utils.logCompatibilityWarning(
        `dae | Effect "${this.name}": flags.dae.stackable ${stackable} is deprecated, migrated to "${stackable ? "multi" : "none"}".`,
        { once: true, stack: false }
      );
    }
    // ATL → token.* pre-write normalisation (Layer A — enabled by "migrate" and "full").
    if (atlRewriteAtPreWrite) {
      // @ts-expect-error v14 effect.system.changes
      const changes = this.system?.changes;
      if (Array.isArray(changes) && changes.length > 0) {
        const rewritten = rewriteAtlChanges(changes);
        if (rewritten !== changes) {
          // @ts-expect-error v14 updateSource accepts system.changes
          this.updateSource({ "system.changes": rewritten });
        }
      }
    }
    /*
     * Deferred-reference backstop. DAE's own apply path restores `##` before creating the effect;
     * effects that reach an actor another way (dnd5e's chat-card apply, enchantments, a dragged
     * effect) never pass through it. Only for an effect being applied (to an actor, or an applied
     * enchantment): an effect added to or duplicated on an item is content, and its `##` must survive
     * until it is applied.
     */
    {
      // @ts-expect-error v14 effect.system.changes
      const changes = this.system?.changes as DAEChangeData[] | undefined;
      const beingApplied = this.parent instanceof CONFIG.Actor.documentClass
        // @ts-expect-error no dnd5e-types
        || !!this.isAppliedEnchantment;
      if (beingApplied && Array.isArray(changes) && changes.some(c => typeof c?.value === "string" && c.value.includes("##"))) {
        const restored = changes.map(c => typeof c?.value === "string" && c.value.includes("##")
          ? { ...c, value: c.value.replaceAll("##", "@") } : c);
        // @ts-expect-error v14 updateSource accepts system.changes
        this.updateSource({ "system.changes": restored });
      }
    }
    // A transfer effect added to an item an actor owns rolls its inline rolls for that actor.
    if (this.parent instanceof CONFIG.Item.documentClass && this.parent.parent instanceof CONFIG.Actor.documentClass && effectIsTransfer(this)) {
      const source = this.toObject() as AnyMutableObject;
      if (await rollEffectSource(source, this.parent.parent, false)) {
        // @ts-expect-error v14 updateSource accepts system.changes
        this.updateSource({ "system.changes": source.system.changes, "flags.dae.inlineRolls": source.flags.dae.inlineRolls });
      }
    }
    let result = await _preCreateActiveEffectRemoveExisting.bind(this)(data, context, user);
    if (result !== false) result = await _preCreateActiveEffectIncrement.bind(this)(data, context, user);
    // @ts-expect-error no dnd5e-types
    if (this.active && this.type !== "enchantment" && dependentConditions /* && !this.flags?.dae?.autoCreated */) {
      await daeSystemClass.preCreateActiveEffect(this);
      if (debugEnabled > 0) warn("_preCreateActiveEffect", this, context);
      // Status effect reconciliation now handled via queueStatusReconciliation hook
    }
    // Source/target expiries are kept verbatim; patching.ts evaluates them (dnd5e 6.0 does so natively).
    if (result !== false) result = await wrapped(data, context, user);
    // dnd5e 6 does this in its own _preCreate
    if (result !== false && daeManagesTurnExpiry) defaultInCombatExpiry(this);
    return result;
  }

  // An item landing on an actor (created, dragged, duplicated) rolls its transfer effects' inline rolls afresh.
  libWrapper.register("dae", "CONFIG.Item.documentClass.prototype._preCreate", _preCreateItemInlineRolls, "WRAPPER");
  async function _preCreateItemInlineRolls(this: Item.Implementation, wrapped, data, options, user) {
    const result = await wrapped(data, options, user);
    if (result === false || !(this.parent instanceof CONFIG.Actor.documentClass)) return result;
    const effects = await rollItemSource(this, this.parent, false);
    if (effects) this.updateSource({ effects } as Item.UpdateData);
    return result;
  }

  // An actor created with items (imported, duplicated) rolls only the ones never rolled.
  libWrapper.register("dae", "CONFIG.Actor.documentClass.prototype._preCreate", _preCreateActorInlineRolls, "WRAPPER");
  async function _preCreateActorInlineRolls(this: Actor.Implementation, wrapped, data, options, user) {
    const result = await wrapped(data, options, user);
    if (result === false) return result;
    let changed = false;
    const items: AnyMutableObject[] = [];
    for (const item of this.items) {
      const effects = await rollItemSource(item, this, true);
      if (effects) changed = true;
      items.push({ ...item.toObject(), ...(effects ? { effects } : {}) });
    }
    if (changed) this.updateSource({ items } as Actor.UpdateData);
    return result;
  }

  libWrapper.register("dae", "CONFIG.ActiveEffect.documentClass.prototype._preDelete", _preDeleteActiveEffect, "MIXED");
  async function _preDeleteActiveEffect(this: ActiveEffect.Implementation, wrapped, options: ActiveEffect.Database.PreDeleteOptions, user: User.Implementation) {
    let result = await _preDeleteActiveEffectDecrement.bind(this)(options, user);
    if (result !== false) result = wrapped(options, user);
    return result;
  }

  libWrapper.register("dae", "CONFIG.ActiveEffect.documentClass.prototype._preUpdate", _preUpdateActiveEffect, "MIXED");
  async function _preUpdateActiveEffect(wrapped, ...args) {
    const [changed, options, userId] = args;

    // ATL → token.* pre-write normalisation (Layer A — enabled by "migrate" and "full").
    // Only rewrite when the update touches system.changes; otherwise leave as-is so non-change
    // updates (name, disabled toggle, etc.) don't cause spurious work.
    if (atlRewriteAtPreWrite && Array.isArray(changed?.system?.changes)) {
      const rewritten = rewriteAtlChanges(changed.system.changes);
      if (rewritten !== changed.system.changes) {
        changed.system.changes = rewritten;
      }
    }

    if (dependentConditions) {
      let shouldInclude = this.active;
      if (this.parent instanceof Item && !this.transfer) shouldInclude = false;
      // If the effect is active only process changes if the statuses of the effect changed
      const changedStatuses = new Set(changed.statuses);
      const statusesChanged = this.statuses.difference(changedStatuses).size > 0 && this.statuses.size !== changedStatuses.size;
      if (shouldInclude && (statusesChanged || changed.disabled !== undefined || changed.isSuppressed !== undefined)) {
        if (debugEnabled > 0) warn("preUpdateActiveEffect ", this, changed, options);
        // Status effect reconciliation now handled via queueStatusReconciliation hook
      }
    }

    // Inline rolls: an effect on an actor gets the totals written in; a transfer effect on an owned item keeps its
    // formulas and rolls again only the changes whose formula changed.
    const parent = this.parent;
    try {
      if (parent instanceof CONFIG.Actor.documentClass) {
        const effectiveChanges: AnyMutableObject[] = foundry.utils.deepClone(changed.system?.changes ?? this.system?.changes ?? []);
        let anyResolved = false;
        for (const change of effectiveChanges) {
          const value = convertChangeValue(change, `${this.name} (${this.uuid})`);
          if (hasInlineRoll(value)) change.value = await rollInline(value, parent, this.name);
          else if (value === change.value) continue;
          else change.value = value;
          anyResolved = true;
        }
        if (anyResolved) foundry.utils.setProperty(changed, "system.changes", effectiveChanges);
      } else if (parent instanceof CONFIG.Item.documentClass && parent.parent instanceof CONFIG.Actor.documentClass
        && effectIsTransfer(this) && Array.isArray(changed.system?.changes)) {
        const source: { name: string, system: { changes: AnyMutableObject[] }, flags: { dae: { inlineRolls: InlineRollRecord[] } } } = {
          name: changed.name ?? this.name, system: { changes: foundry.utils.deepClone(changed.system.changes) },
          flags: { dae: { inlineRolls: this.flags.dae?.inlineRolls ?? [] } } };
        if (await rollEffectSource(source, parent.parent, true)) {
          changed.system.changes = source.system.changes;
          foundry.utils.setProperty(changed, "flags.dae.inlineRolls", source.flags.dae.inlineRolls);
        }
      }
    } catch (err) {
      console.warn(`dae | _preUpdateActiveEffect inline roll error: Effect ${this.name}`, changed, err);
    }

    return wrapped(...args);
  }


  Hooks.on("createActiveEffect", createActiveEffectHook);
  Hooks.on("updateItem", (item, data, options, userId) => updateStatusEffects(item, options, userId));
  Hooks.on("deleteItem", (item, options, userId) => updateStatusEffects(item, options, userId));
  Hooks.on("createItem", (item, options, userId) => updateStatusEffects(item, options, userId));
  Hooks.on("createActor", (actor, options, userId) => updateStatusEffects(actor, options, userId));

  Hooks.on("deleteActiveEffect", deleteActiveEffectHook);
  //  Hooks.on("preDeleteActiveEffect", preDeleteActiveEffectHook); - moved wrapper to avoid race conditions
  Hooks.on("preUpdateActiveEffect", recordDisabledSuppressedHook);
  Hooks.on("updateActiveEffect", updateActiveEffectHook);
  // Queue status reconciliation after effect changes complete
  Hooks.on("createActiveEffect", (effect: ActiveEffect.Implementation, options: object, userId: string) => {
    queueStatusesReconciliation(effect, userId);
  });
  Hooks.on("deleteActiveEffect", (effect: ActiveEffect.Implementation, options: object, userId: string) => {
    queueStatusesReconciliation(effect, userId);
  });
  Hooks.on("updateActiveEffect", (effect: ActiveEffect.Implementation, data: object, options: object, userId: string) => {
    queueStatusesReconciliation(effect, userId);
  });

  // Add the active effects title bar actions
  Hooks.on("getHeaderControlsItemSheet5e", appendDocumentSheetHeaderControls)
  Hooks.on("getHeaderControlsActorSheetV2", appendDocumentSheetHeaderControls)
  Hooks.on("renderItemSheetV2", colorSheetHeaderButtons) // tidy5e item sheets
  Hooks.on("renderItemSheet5e", colorSheetHeaderButtons) // dnd5e item sheets
  Hooks.on("renderActorSheetV2", colorSheetHeaderButtons)
  Hooks.on("renderActorSheetV2", injectDeleteExpiredButton)

  setupSpecialDurationHooks();

  // Open DIMEditor as the field editor for macro-command change rows in the active effect sheet.
  registerFieldEditor({
    keyMatch: "flags.dae.macro.command",
    editor: async (currentValue, context) => new Promise<string | null>((resolve) => {
      new DIMEditor({
        initialCommand: currentValue,
        name: context.effect?.name ?? i18n("dae.DIMEditor.Name"),
        img: context.effect?.img,
        uniqueIdSuffix: `${context.effect?.uuid ?? foundry.utils.randomID()}-${context.changeIndex}`,
        onSubmit: (newValue: string) => resolve(newValue),
        onCancel: () => resolve(null),
      }).render({ force: true });
    }),
    icon: "fas fa-code",
    tooltip: "dae.DIMEditor.Name",
  });

  //@ts-expect-error no typings for this (can we maybe ditch in favor of our own tokenization?)
  tokenizer = new DETokenizeThis({
    shouldTokenize: ['(', ')', ',', '*', '/', '%', '+', '===', '==', '!=', '!', '<', '> ', '<=', '>=', '^']
  });
  actionQueue = new foundry.utils.Semaphore();
}

// Not compendium actors: their conditions would race importers replacing their effects, and a world copy gets its own on createActor
function scheduleReconciliation(actor: Actor.Implementation) {
  if (!dependentConditions || actor.inCompendium || reconciliationPending.has(actor.uuid)) return;
  reconciliationPending.add(actor.uuid);
  actionQueue.add(async () => {
    try {
      reconciliationPending.delete(actor.uuid);
      await reconcileActorStatuses(actor);
    } catch (err) {
      console.warn("dae | Error reconciling actor statuses:", err);
    }
  });
}

function scheduleConditionalEffects(actor: Actor.Implementation, updates: TokenDocument.UpdateData | Actor.UpdateData) {
  if (conditionalEffectsPending.has(actor.uuid)) return;
  conditionalEffectsPending.add(actor.uuid);
  actionQueue.add(async () => {
    try {
      conditionalEffectsPending.delete(actor.uuid);
      await processConditionalEffects(actor, updates);
    } catch (err) {
      console.warn("dae | Error processing conditional effects:", err);
    }
  });
}

function updateStatusEffects(doc, options, userId) {
  if (!dependentConditions || userId !== game.user?.id) return;
  let actor = doc;
  if (doc instanceof Item || doc instanceof ActiveEffect) actor = doc.parent;
  if (actor instanceof Item) actor = actor.parent;
  if (actor instanceof Actor) scheduleReconciliation(actor);
}

function queueStatusesReconciliation(effect: ActiveEffect.Implementation, userId: string) {
  if (!dependentConditions || userId !== game.user?.id) return;
  const hasStatuses = !!effect.statuses?.size;
  // @ts-expect-error v14 effect.system.changes
  const hasCIChanges = effect.system?.changes?.some(c => c.key.startsWith("system.traits.ci"));
  if (!hasStatuses && !hasCIChanges) return;
  const actor = effect.parent instanceof Actor ? effect.parent : (effect.parent as Item)?.parent;
  if (actor instanceof Actor) scheduleReconciliation(actor);
}

/**
 * Reconcile the status effects on an actor based on all active effects.
 * This calculates what statuses SHOULD exist based on current effects,
 * then adds missing statuses and removes extra ones.
 *
 * Status effect documents use static _ids (e.g., staticID("dnd5eparalyzed")).
 * The dnd5e character sheet determines active conditions by checking for these
 * documents, not actor.statuses. So reconciliation must create/remove the
 * actual documents to keep the sheet in sync.
 */
async function reconcileActorStatuses(actor: Actor.Implementation) {
  if (!dependentConditions) return;
  if (debugEnabled > 0) warn("reconcileActorStatuses", actor.name);

  const excludedStatuses = ["concentrating", "bonusaction", "reaction", "encumbered", "heavilyEncumbered", "exceedingCarryingCapacity"];

  // Calculate expected statuses from all active effects
  // Skip status effect documents with static _ids (those are the output, not the input)
  let expectedStatuses = new Set<string>();
  const existingStaticStatusIds = new Set<string>(); // Track which static-_id status effect documents exist
  const autoCreatedStaticStatusIds = new Set<string>(); // Track which were created by DAE (vs manually by user)

  for (let effect of actor.allApplicableEffects()) {
    if (effect.flags?.["dfreds-convenient-effects"]) continue;
    // Check if this effect has a static _id matching a CONFIG status effect.
    // These are status effect documents (created by toggleStatusEffect, fromStatusEffect,
    // or by this reconciliation). They are the OUTPUT of reconciliation, not input.
    // Track these REGARDLESS of active state — an inactive (disabled/suppressed) static-id
    // document still needs to be removed if the actor is immune to that condition.
    const configStatusEffect = getStatusEffectsArray().find(se => se._id === effect.id);
    if (configStatusEffect) {
      existingStaticStatusIds.add(configStatusEffect.id);
      if (effect.flags?.dae?.autoCreated) {
        autoCreatedStaticStatusIds.add(configStatusEffect.id);
      }
      // Only count sub-statuses from ACTIVE static-id effects as expected
      if (effect.active) {
        for (const status of effect.statuses) {
          if (status !== configStatusEffect.id) {
            expectedStatuses.add(status);
          }
        }
      }
      continue; // Don't add all statuses via the union below
    }

    if (!effect.active) continue;

    expectedStatuses = expectedStatuses.union(effect.statuses);
  }

  // Filter out statuses we don't manage
  for (const status of excludedStatuses) {
    expectedStatuses.delete(status);
  }

  // Filter out statuses the actor is immune to
  // @ts-expect-error no dnd5e-types
  const conditionImmunities: Set<string> | undefined = actor.system.traits?.ci?.value;
  if (conditionImmunities) {
    for (const condition of conditionImmunities) {
      expectedStatuses.delete(condition);
    }
  }

  // Add status effect documents that should exist but don't
  for (let status of expectedStatuses) {
    if (existingStaticStatusIds.has(status)) continue;

    const statusEffect = getStatusEffectsArray().find(se => se.id === status);
    if (!statusEffect) continue;
    if (!statusEffect._id) continue;
    if ((statusEffect.statuses as Array<string>)?.includes(status)) continue; // Self referential

    try {
      await toggleActorStatusEffect(actor, status, { active: true, flags: { dae: { autoCreated: true } } });
    } catch (err) {
      if (!String(err).includes("does not exist") && !String(err).includes("already exists")) {
        console.warn("dae | Error adding status effect:", status, err);
      }
    }
  }

  // Remove status effect documents that should not exist
  // Only remove auto-created documents (created by DAE reconciliation), not ones
  // manually applied by the user from the character sheet
  // Exception: CI overrides even manual statuses
  for (let statusEffectId of existingStaticStatusIds) {
    if (expectedStatuses.has(statusEffectId)) continue;
    if (!autoCreatedStaticStatusIds.has(statusEffectId) && !conditionImmunities?.has(statusEffectId)) continue;

    const statusEffect = getStatusEffectsArray().find(se => se.id === statusEffectId);
    if (!statusEffect) continue;
    if (!statusEffect._id) continue;

    try {
      await toggleActorStatusEffect(actor, statusEffectId, { active: false });
    } catch (err) {
      if (!String(err).includes("does not exist")) {
        console.warn("dae | Error removing status effect:", statusEffectId, err);
      }
    }
  }
}

Hooks.once("tidy5e-sheet.ready", api => {
  api.registerItemHeaderControls?.({
    controls: [
      {
        icon: 'fas fa-wrench',
        label: "DAE",
        async onClickAction() {
          new ActiveEffects({ document: this.document }).render({ force: true });
        }
      },
      {
        icon: 'fas fa-file-pen',
        label: "DIME",
        async onClickAction() {
          new DIMEditor({ document: this.document }).render({ force: true });
        }
      }
    ]
  });
});

function appendDocumentSheetHeaderControls(app, controls) {
  const daeTitle = i18n("dae.ActiveEffectName");
  const DIMETitle = i18n("dae.DIMEditor.Name");
  if (daeTitleBar) {
    controls.push({
      label: daeTitle,
      icon: "fa-solid fa-wrench",
      action: "dae-effects",
      onClick: () => new ActiveEffects({ document: app.document }).render({ force: true })
    });
  }
  if (DIMETitleBar && app.document instanceof Item) {
    controls.push({
      label: DIMETitle,
      icon: "fa-solid fa-file-pen",
      action: "dae-dime",
      onClick: () => new DIMEditor({ document: app.document }).render({ force: true })
    });
  }

  // Color icons in the dnd5e context menu (nav#context-menu).
  // dnd5e replaces the standard Foundry .controls-dropdown with a ContextMenu5e,
  // and getHeaderControls fires when that context menu opens.
  // Use setTimeout so the context menu DOM has been built.
  if (!daeColorTitleBar) return;
  const doc = app.document;
  if (!doc) return;
  const green = "#36ba36";

  let hasEffects = false;
  let hasMacro = false;
  if (daeTitleBar) {
    if (doc instanceof Actor) hasEffects = doc.allApplicableEffects().next().value !== undefined;
    else hasEffects = doc.effects?.size > 0;
  }
  if (DIMETitleBar && doc instanceof Item) {
    const validMacroFlags = ["flags.dae.macro.command", "flags.itemacro.macro.command", "flags.itemacro.macro.data.command"];
    hasMacro = validMacroFlags.some(f => foundry.utils.getProperty(doc, f));
  }
  if (!hasEffects && !hasMacro) return;

  setTimeout(() => {
    const contextItems = document.querySelectorAll("nav#context-menu .context-item");
    contextItems.forEach(item => {
      const label = item.textContent?.trim() ?? "";
      const icon = item.querySelector("i") as HTMLElement | null;
      if (!icon) return;
      if (hasEffects && label.includes(daeTitle)) {
        icon.style.color = green;
      }
      if (hasMacro && label.includes(DIMETitle)) {
        icon.style.color = green;
      }
    });
  });
}

// Inject global CSS rules once for DAE/DIME icon coloring.
// Color tidy5e header buttons on render (tidy5e puts buttons directly in .window-header)
function colorSheetHeaderButtons(app, _element) {
  if (!daeColorTitleBar) return;
  const appElement = app.element;
  if (!appElement) return;
  const doc = app.document;
  if (!doc) return;
  const green = "#36ba36";

  if (daeTitleBar) {
    let hasEffects = false;
    if (doc instanceof Actor) hasEffects = doc.allApplicableEffects().next().value !== undefined;
    else hasEffects = doc.effects?.size > 0;
    if (hasEffects) {
      const tidyWrench = appElement.querySelector(".window-header .header-control.fa-wrench") as HTMLElement;
      if (tidyWrench) tidyWrench.style.color = green;
    }
  }
  if (DIMETitleBar && doc instanceof Item) {
    const validMacroFlags = ["flags.dae.macro.command", "flags.itemacro.macro.command", "flags.itemacro.macro.data.command"];
    const hasMacro = validMacroFlags.some(f => foundry.utils.getProperty(doc, f));
    if (hasMacro) {
      const tidyFilePen = appElement.querySelector(".window-header .header-control.fa-file-pen") as HTMLElement;
      if (tidyFilePen) tidyFilePen.style.color = green;
    }
  }
}

function injectDeleteExpiredButton(app, _element) {
  const actor = app.document;
  if (!(actor instanceof Actor)) return;
  const appElement = app.element;
  if (!appElement) return;

  // Find the suppressed effects section header
  const suppressedSection = appElement.querySelector('.items-section[data-effect-type="suppressed"]');
  if (!suppressedSection) return;
  const header = suppressedSection.querySelector('.items-header');
  if (!header) return;

  // Don't add duplicate buttons
  if (header.querySelector('[data-action="deleteExpiredEffects"]')) return;

  const controlsDiv = header.querySelector('.item-controls, .effect-controls') ?? header;
  const btn = document.createElement("a");
  btn.classList.add("effect-control", "item-control");
  btn.dataset.action = "deleteExpiredEffects";
  btn.dataset.tooltip = i18n("dae.deleteExpiredEffects");
  btn.setAttribute("aria-label", i18n("dae.deleteExpiredEffects"));
  btn.style.color = "var(--color-text-primary, #191813)";
  btn.innerHTML = '<i class="fas fa-trash-can"></i>';
  btn.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const expiredEffects: string[] = [];
    for (const effect of actor.allApplicableEffects()) {
      // @ts-expect-error expired not in fvtt-types _source schema
      if (effect.duration?.expired || effect._source?.duration?.expired) {
        if (effect.id) expiredEffects.push(effect.id);
      }
    }
    if (expiredEffects.length === 0) return;
    await actor.deleteEmbeddedDocuments("ActiveEffect", expiredEffects);
  });
  controlsDiv.prepend(btn);
}

export function daeSetupActions() {
  daeSystemClass.setupActions();
}

export function fetchParams() {
  setDebugLevel(game.settings.get("dae", "ZZDebug"));
  // useAbilitySave = game.settings.get("dae", "useAbilitySave") disabled as of 0.8.74
  noDupDamageMacro = game.settings.get("dae", "noDupDamageMacro");
  disableEffects = game.settings.get("dae", "disableEffects");
  daeTitleBar = game.settings.get("dae", "DAETitleBar");
  DIMETitleBar = game.settings.get("dae", "DIMETitleBar");
  daeColorTitleBar = game.settings.get("dae", "DAEColorTitleBar");
  // showDeprecation = game.settings.get("dae", "showDeprecation") ?? true;
  dependentConditions = game.settings.get("dae", "DependentConditions") ?? false;
  specialDurationExpiryAction = game.settings.get("dae", "expiryAction") ?? "default";
  fetchDurationParams();

  // ATL compatibility policy — derive the per-layer flags.
  atlCompatMode = (game.settings.get("dae", "atlCompatibility") as any) ?? "legacy";
  atlRewriteAtPreWrite = atlCompatMode === "migrate" || atlCompatMode === "full";
  atlRewriteAtRuntime  = atlCompatMode === "runtime" || atlCompatMode === "full";
  atlMigrateWorldData  = atlCompatMode === "migrate" || atlCompatMode === "full";

  Hooks.callAll("dae.settingsChanged")
}

export function getTokenDocument(tokenRef: Token | TokenDocument | string | Actor): TokenDocument | undefined {
  if (!tokenRef) return undefined;
  let entity: any = tokenRef;
  if (typeof tokenRef === "string") entity = fromUuidSync(tokenRef);
  if (entity instanceof TokenDocument) return entity;
  if (entity instanceof foundry.canvas.placeables.Token) return entity.document;
  if (entity instanceof Actor) {
    if (entity.isToken) return entity.token ?? undefined;
    return entity.getActiveTokens(false, true)[0];
  }
  if (entity instanceof Item && entity.parent instanceof Actor) return getTokenDocument(entity.parent);
  if (entity instanceof ActiveEffect) {
    const parent = entity.parent;
    if (parent instanceof Actor) return getTokenDocument(parent);
    if (parent instanceof Item && parent.parent instanceof Actor) return getTokenDocument(parent.parent);
  }
  return undefined;
}

export function getToken(tokenRef: Token | TokenDocument | string | Actor): Token | undefined {
  return getTokenDocument(tokenRef)?.object ?? undefined;
}

export function actorFromUuid(uuid: string): Actor.Implementation | null {
  let doc: any = fromUuidSync(uuid);
  while (doc && !(doc instanceof CONFIG.Actor.documentClass)) {
    doc = doc.actor ?? doc.parent;
  }
  return doc ?? null;
}

// Allow limited recursion of the formula replace function for things like
// bonuses.heal.damage in spell formulas.
export function replaceFormulaData(wrapped, formula, data: any = {}, { missing, warn = false } = { missing: undefined, warn: false }) {
  let result = formula;
  const maxIterations = 3;
  data.Embed = "@Embed"; // Never replace these
  if (typeof formula !== "string") return formula;
  if (formula.includes(DAE_EVAL)) result = formula = evaluateDaeEvals(formula, data);
  for (let i = 0; i < maxIterations; i++) {
    if (!result.includes("@")) break;
    try {
      result = wrapped(result, data, { missing, warn });
    } catch (err) {
      error(err, formula, data, missing, warn);
    }
  }
  return result;
}


const DAE_EVAL = "dae.eval(";

/**
 * A formula's dae.eval(...) terms replaced by their values, evaluated with `data`: how a dnd5e formula field evaluated
 * late (simplifyBonus and the like) gets an expression with derived values, such as a ternary on an ability modifier.
 * A term whose references `data` cannot fill (e.g. dnd5e checking the field's value without data) counts as 0.
 */
function evaluateDaeEvals(formula: string, data: AnyObject): string {
  let out = "";
  let from = 0;
  for (let start = formula.indexOf(DAE_EVAL); start >= 0; start = formula.indexOf(DAE_EVAL, from)) {
    let depth = 1;
    let end = start + DAE_EVAL.length;
    for (; end < formula.length && depth; end++) {
      if (formula[end] === "(") depth++;
      else if (formula[end] === ")") depth--;
    }
    if (depth) break;
    const value = daeEvalValue(formula.slice(start + DAE_EVAL.length, end - 1), data);
    // Bracketed only when negative, which a formula needs: a bare number stays a number (a flag's value).
    out += `${formula.slice(from, start)}${value < 0 ? `(${value})` : value}`;
    from = end;
  }
  return out + formula.slice(from);
}

function daeEvalValue(expression: string, data: AnyObject): number {
  const resolved = Roll.replaceFormulaData(expression, data);
  if (resolved.includes("@")) return 0;
  let result = daeSystemClass.safeEval(resolved, { ...data });
  // dae.eval("2 + 3"): a quoted expression evaluates to its text, which is then evaluated.
  if (typeof result === "string") result = daeSystemClass.safeEval(result, { ...data });
  const value = Number(result);
  return Number.isFinite(value) ? value : 0;
}

export function tokensForActor(actorRef: Actor | string | undefined | null): Token[] | undefined {
  let actor: Actor.Implementation;
  if (!actorRef) return undefined
  if (typeof actorRef === "string") actor = fromUuidSync(actorRef) as Actor.Implementation;
  else actor = actorRef;
  if (actor.token) return [actor.token.object!];
  if (!(actor instanceof Actor)) return undefined;

  const tokens: Token[] = actor.getActiveTokens();
  if (!tokens.length) return undefined;
  const controlled = tokens.filter(t => t.controlled);
  return controlled.length ? controlled : tokens;
}

export function tokenForActor(actor: Actor | string | undefined | null): Token | undefined {
  const tokens = tokensForActor(actor);
  if (!tokens) return undefined;
  return tokens[0];
}

export function effectIsTransfer(effect: ActiveEffect.Implementation | ActiveEffect.Source) {
  return effect.transfer === true;
}

export async function delay(interval: number) {
  await new Promise(resolve => setTimeout(resolve, interval));
}

export function safeGetGameSetting(moduleName: any, settingName: any): any | undefined {
  // @ts-expect-error too generic to type
  if (game.settings.settings.get(`${moduleName}.${settingName}`))
    return game.settings.get(moduleName, settingName);
  else return undefined;
}

export function getApplicableEffects(actor, { includeEnchantments, includeExpired = false }) {
  if (!actor) return [];
  let effects: any[] = [];
  for (let effect of actor.allApplicableEffects()) {
    if (!includeExpired && effect.duration?.expired) continue;
    effects.push(effect);
  }
  if (includeEnchantments) {
    const enchantments = actor.items.contents.flatMap(i => i.effects.contents).filter(ae => {
      if (!ae.isAppliedEnchantment) return false;
      if (!includeExpired && ae.duration?.expired) return false;
      return true;
    });
    effects = effects.concat(enchantments);
  }
  return effects;
}

// This does not work since the hook is called after _preCreateEffect is called which leads to the update source firing too late
export async function toggleActorStatusEffectPossible(actor: Actor, statusId: string, { active = false, overlay = false, enableCondition = "", origin = "", flags = {} }: ToggleStatusEffectOptions = {}): Promise<ActiveEffect.Implementation | boolean | undefined> {
  let preCreateActiveEffectHookId;
  try {
    const statusEffect = getStatusEffectsArray().find(e => e.id === statusId);
    preCreateActiveEffectHookId = Hooks.on("preCreateActiveEffect", (effect: any, data: any, options: any, userId: string) => {
      if (effect._id !== statusEffect?._id) return;
      if (origin) effect.updateSource({ origin });
      if (enableCondition?.length) effect.updateSource({ "flags.dae.enableCondition": enableCondition });
      if (overlay) effect.updateSource({ "flags.core.overlay": true });
      flags = foundry.utils.mergeObject(effect.flags ?? {}, flags ?? {}, { inplace: false });
      effect.updateSource({ flags });
    })
    return await actor.toggleStatusEffect(statusId, { active, overlay });
  } catch (err) {
    console.error("dae | toggleActorStatusEffect", err);
  } finally {
    if (preCreateActiveEffectHookId) Hooks.off("preCreateActiveEffect", preCreateActiveEffectHookId);
  }
}
// TODO can't use the core toggleActorStatusEffect, consider patching this to replace the core one
export async function toggleActorStatusEffect(actor: Actor, statusId: string, { active = false, overlay = false, enableCondition = "", origin = "", flags = {} }: ToggleStatusEffectOptions = {}): Promise<ActiveEffect[] | boolean> {
  if (debugEnabled > 0)
    warn("toggleActorStatusEffect", actor, statusId, active);
  const status = getStatusEffectsArray().find(e => e.id === statusId);
  if (!status) throw new Error(`Invalid status ID "${statusId}" provided to Actor#toggleStatusEffect`);
  let existing: ActiveEffect[] = [];
  // Find the effect with the static _id of the status effect
  if (status._id) {
    const effect: ActiveEffect | undefined = actor.effects.get(status._id as string);
    if (effect?.id) existing.push(effect);
  }

  // If no static _id, find all single-status effects that have actor status
  else {
    for (const effect of actor.effects) {
      const statuses = effect.statuses;
      if ((statuses.size === 1) && statuses.has(status.id)) existing.push(effect);
    }
  }
  // Remove the existing effects unless the status effect is forced active
  if (existing.length) {
    if (active) {
      return true;
    }
    try {
      await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map(e => e.id!));
    } catch (err) {
      // Race: a concurrent call deleted it first
      if (!String(err).includes("does not exist")) throw err;
    }
    return false;
  }
  // Create a new effect unless the status effect is forced inactive
  if (!active && active !== undefined) return false;
  const effect = await ActiveEffect.implementation.fromStatusEffect(statusId);
  if (origin) effect.updateSource({ origin });
  if (enableCondition?.length) effect.updateSource({ flags: { dae: { enableCondition: enableCondition } } });
  if (overlay) effect.updateSource({ flags: { core: { overlay: true } } });
  flags = foundry.utils.mergeObject(effect.flags ?? {}, flags ?? {}, { inplace: false });
  effect.updateSource({ flags });
  try {
    const returnEffect = await ActiveEffect.implementation.create(effect.toObject(), { parent: actor, keepId: true });
    return returnEffect ? [returnEffect] : false;
  } catch (err) {
    if (String(err).includes("already exists")) {
      // Race condition: another concurrent call created this status effect first
      return true;
    }
    throw err;
  }
}

/** Condition helpers that read a token's animated position: MidiQOL.canSee/canSense/canSenseModes and the findNearby canSee/isSeen options. */
const VISION_DEPENDENT_CONDITION = /\b(canSee|canSense|canSenseModes|isSeen)\b/;

export async function processConditionalEffects(actor: Actor.Implementation, updates: TokenDocument.UpdateData | Actor.UpdateData) {
  if (!game.users?.activeGM?.isSelf) return;
  if (!actor || !["character", "npc"].includes(actor.type)) return;
  const tokenDocument = tokenForActor(actor)?.document;
  const token = tokenDocument?.object;
  const effectItem = game.items?.getName(i18n("dae.ConditionalEffectsItem"));

  // Midi's distance and cover helpers measure from _source, so only vision needs the animation to finish.
  // The findNearby canSee/isSeen options share their names with the helpers, so one test covers both.
  const conditions: string[] = [];
  for (const ef of effectItem?.effects ?? []) {
    if (!ef.disabled && typeof ef.flags?.dae?.enableCondition === "string") conditions.push(ef.flags.dae.enableCondition);
  }
  for (const effect of actor.allApplicableEffects()) {
    const disableCondition = foundry.utils.getProperty(effect, "flags.dae.disableCondition");
    if (typeof disableCondition === "string") conditions.push(disableCondition);
  }
  if (conditions.some(c => VISION_DEPENDENT_CONDITION.test(c))) {
    // @ts-expect-error missing in fvtt-types currently
    await token?.movementAnimationPromise;
  }

  const rollData = actor.getRollData() as AnyMutableObject;
  if (effectItem) {
    for (let conditionalEffect of effectItem.effects) {
      let enableCondition = conditionalEffect.flags?.dae?.enableCondition;
      if (!enableCondition || conditionalEffect.disabled) continue;
      const ceData: ActiveEffect.Source = conditionalEffect.toObject(false);
      const expression = Roll.replaceFormulaData(enableCondition, rollData);
      const result = daeSystemClass.safeEval(expression, rollData);
      if (!result) continue;
      let overlay = ceData.flags.core?.overlay ?? false;
      const statusEffects: Set<string> = new Set();

      // @ts-expect-error v14 system.changes on toObject() data
      for (let change of ceData.system.changes) {
        if (daeSystemClass.fieldMappings[change.key]) {
          const mapping = daeSystemClass.fieldMappings[change.key];
          if (typeof mapping === "string") {
            change.key = mapping;
          } else {
            change.key = mapping.key;
            if (mapping.value !== undefined) change.value = mapping.value;
            if ((mapping as any).type !== undefined) change.type = (mapping as any).type;
            else if (mapping.mode !== undefined) {
              // Legacy field mapping with numeric mode -- convert to v14 string type
              const modeToType: Record<number, string> = { 0: "custom", 1: "multiply", 2: "add", 3: "downgrade", 4: "upgrade", 5: "override" };
              change.type = modeToType[mapping.mode as number] ?? "custom";
            }
          }
        }

      }
      // @ts-expect-error v14 system.changes on toObject() data
      ceData.system.changes = ceData.system.changes
        .filter(change => change.key !== "StatusEffect" || change.value.startsWith("zce-"));

      for (let status of ceData.statuses) {
        statusEffects.add(status);
      }

      const existingEffect = actor.effects.find(ef => ef.origin === conditionalEffect.uuid);
      if (!existingEffect || ["countDeleteDecrement", "count", "multi"].includes(ceData.flags?.dae?.stackable ?? "")) {
        for (let statusEffect of statusEffects) {
          await toggleActorStatusEffect(actor, statusEffect, { active: true, overlay, origin: conditionalEffect.uuid, enableCondition: enableCondition });
        }
        // @ts-expect-error v14 system.changes on toObject() data
        if (ceData.system.changes.length > 0 || statusEffects.size === 0) {
          if (actor.effects.some(ef => ef.id === ceData._id)) continue;
          ceData.origin = conditionalEffect.uuid;
          if (debugEnabled > 0) warn(`dae | creating conditional effect on ${actor.name} ${actor.uuid}`, ceData)
          await actor.createEmbeddedDocuments("ActiveEffect", [ceData]);
        }
      }
    }
  }


  /*
   * An effect whose enableCondition is false ends as an expired effect does (resolveEffectExpiryAction): deleted, or
   * disabled under "suppress". One disabled that way is enabled again when its condition holds; one disabled by hand
   * is left alone.
   */
  const idsToDelete: string[] = [];
  const effectUpdates: ActiveEffect.UpdateData[] = [];
  for (let effect of actor.effects) {
    let condition = effect?.flags?.dae?.enableCondition;
    if (!condition) continue;
    // add other things to rollData
    rollData.combat = game.combat;
    rollData.time = game.time;
    rollData.effect = effect.toObject();
    const expression = Roll.replaceFormulaData(condition, rollData);
    const result = daeSystemClass.safeEval(expression, rollData);
    const disabledByCondition = !!effect.flags?.dae?.disabledByCondition;
    if (!result) {
      if (resolveEffectExpiryAction(effect) === "delete") idsToDelete.push(effect.id!);
      else if (!effect.disabled) effectUpdates.push({ _id: effect.id!, disabled: true, flags: { dae: { disabledByCondition: true } } });
    } else if (effect.disabled && disabledByCondition) {
      effectUpdates.push({ _id: effect.id!, disabled: false, flags: { dae: { disabledByCondition: false } } });
    }
  }
  if (idsToDelete.length > 0) {
    await actor.deleteEmbeddedDocuments("ActiveEffect", idsToDelete);
  }
  if (effectUpdates.length > 0) {
    await actor.updateEmbeddedDocuments("ActiveEffect", effectUpdates);
  }

  for (let effect of actor.allApplicableEffects()) {
    const disableCondition = foundry.utils.getProperty(effect, "flags.dae.disableCondition");
    if (typeof disableCondition === "string" && disableCondition.trim() !== "") {
      const rollData = (effect.parent?.getRollData() ?? {}) as AnyMutableObject;
      rollData.effect = effect.toObject();
      let value = Roll.replaceFormulaData(disableCondition, rollData, { missing: "0", warn: false });
      try { // Roll parser no longer accepts some expressions it used to so we will try and avoid using it
        let disabled: any;
        if (value.includes("dae.eval(") || value.includes("dae.roll(")) {
          disabled = daeSystemClass.safeEvalExpression(value, rollData);
          disabled = daeSystemClass.safeEval(disabled, rollData);
        } else disabled = daeSystemClass.safeEval(value, rollData);
        if (!!disabled !== effect.disabled) {
          if (debugEnabled > 0) warn("setting disabled effect", effect, disabled)
          await effect.update({ disabled: !!disabled })
        }
      } catch (err) {
        warn("diabledCondition error", err)
      }
    }
  }
  await token?.drawEffects();
}

// TODO (Michael) type this for activities not just items
export function enumerateBaseValues(
  objectDataModels: Record<string, typeof foundry.abstract.DataModel<any, Item.Implementation>>,
  logErrors: boolean = true
): BaseValuesReturn {
  const baseValues: BaseValuesReturn = {};
  //@ts-expect-error no dnd5e-types
  const dataModels: any = game.system.dataModels;
  const MappingField = dataModels.fields.MappingField;

  // TODO (Michael) once dnd5e-types in, ensure mapping field properly typed
  function processMappingField(key: string, mappingField: any, baseValues: BaseValuesInner, logErrors = true) {
    const fields = mappingField.initialKeys;
    if (!fields) return;
    for (let fieldKey of Object.keys(fields)) {
      if (mappingField.model instanceof SchemaField) {
        processSchemaField(`${key}.${fieldKey}`, mappingField.model, baseValues, logErrors);
      } else if (mappingField.model instanceof MappingField) {
        processMappingField(`${key}.${fieldKey}`, mappingField.model, baseValues, logErrors);
      } else {
        // TODO come back and see how favorites might be supported.
        if (fieldKey.includes("favorites")) return;
        // let initial = fields[fieldKey].initial ?? 0;;
        // if (typeof fields[fieldKey].initial === "function") { initial = fields[fieldKey].initial() ?? ""; }
        baseValues[`${key}.${fieldKey}`] = [fields[fieldKey], ""];
      }
    }
  }
  function processSchemaField(key: string, schemaField: foundry.data.fields.SchemaField<any>, baseValues: BaseValuesInner, logErrors = true) {
    const fields = schemaField.fields;
    for (let fieldKey of Object.keys(fields)) {
      if (fields[fieldKey] instanceof SchemaField) {
        processSchemaField(`${key}.${fieldKey}`, fields[fieldKey], baseValues, logErrors);
      }
      else if (fields[fieldKey] instanceof MappingField) {
        processMappingField(`${key}.${fieldKey}`, fields[fieldKey], baseValues, logErrors);
      } else {
        if (fieldKey.includes("favorites")) return; //TODO see above
        // let initial = fields[fieldKey].initial ?? 0;;
        // if (typeof fields[fieldKey].initial === "function") { initial = fields[fieldKey].initial() ?? ""; }
        baseValues[`${key}.${fieldKey}`] = [fields[fieldKey], ""];
      }
    }
  }
  for (let key of Object.keys(objectDataModels)) {
    const schema = objectDataModels[key].schema;
    baseValues[key] = {};
    if (schema instanceof SchemaField) {
      processSchemaField(`system`, schema, baseValues[key]);
    } else if (logErrors) console.error("Unexpected field ", key, schema)
  }
  return baseValues;
}

export function effectBaseName(effect: ActiveEffect.Implementation): string {
  if (!effect?.name) return "";
  if (!effect.flags.dae?.stacks) return effect.name;
  const returnName = effect.name.replace(/(.*) \([0-9]+\)?$/, "$1");
  return returnName;
}

export function busyWait(seconds: number) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

export function getStaticID(id: string): string {
  id = `dnd5e${id}`;
  if (id.length >= 16) return id.substring(0, 16);
  return id.padEnd(16, "0");
}

export type DoEffectsTargets = (string | Actor.Implementation | TokenOrDocument)[] | undefined;

export interface DoEffectsOptions extends InexactPartial<{
  applyAll: boolean;
  context: AnyObject;
  critical: boolean;
  damageTotal: number | null;
  effectsToApply: string[];
  fumble: boolean;
  itemCardUuid: string | null;
  metaData: AnyObject;
  origin: string;
  removeMatchLabel: boolean;
  selfEffects: "selfEffectsAlways" | "selfEffectsAll" | "none";
  spellLevel: number;
  toggleEffect: boolean;
  tokenId: string;
  whisper: boolean;
}> { }

interface ToggleStatusEffectOptions {
  active?: boolean;
  overlay?: boolean;
  enableCondition?: string;
  origin?: string;
  flags?: any;
}

/*
 * A field, its forced mode, and optionally the phase it must be applied in.
 *
 * Specials are otherwise all "final", which is right for keys that overwrite something the system
 * has just computed. It is wrong for a key the system computes *from* — see `ac.flat`.
 */
import type { SpecPhase } from "./Systems/DAESystem.js";

export type BaseValuesInner = Record<string, [foundry.data.fields.DataField<any>, string, SpecPhase?]>
type BaseValuesReturn = Record<string, BaseValuesInner>;

interface EvalArgsInput {
  effectData: ActiveEffect.Source;
  item?: Item.Implementation | null;
  context: AnyObject;
  actor: Actor.Implementation;
  change: ActiveEffect.ChangeData;
  spellLevel?: number;
  damageTotal?: number;
  doRolls?: boolean;
  critical?: boolean;
  fumble?: boolean;
  whisper?: boolean;
  itemCardUuid?: string | null;
  tokenUuid?: string | null;
}

function isSelfAuraChange(effect: ActiveEffect.Implementation, actor: Actor.Implementation): boolean {
  return foundry.utils.getProperty(effect, "flags.ActiveAuras.isAura") === true
    && foundry.utils.getProperty(effect, "flags.ActiveAuras.ignoreSelf") === true
    && !!effect.origin?.startsWith(actor.uuid);
}
