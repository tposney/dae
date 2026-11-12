### 14.0.23
* Fixed: with Dependent Conditions on, updating an existing compendium monster in ddb-importer could stop with "ActiveEffect dnd5einvisible00 does not exist" (compendium actors no longer get dependent conditions; an actor created in the world gets them).

### 14.0.22

* Changed: DAE has moved to GitHub (https://github.com/tposney/dae): updates and downloads come from its releases, and issues are reported there. Installed copies move over with this update.

### 14.0.21

* Changed: updates are served from GitLab Pages (https://tposney.gitlab.io/dae/v14/module.json), so update checks no longer fail when GitLab rate-limits repository files. Changelog: https://tposney.gitlab.io/dae/v14/changelog.html.

### 14.0.20

* Fixed: DAE's API (`DAE`, `game.modules.get("dae").api`) was set in `setup`, after Foundry prepares world documents, so a module calling it during that first preparation got `DAE is not defined`; it is now set in `init`.
* Fixed: the description of `system.attributes.concentration.roll.min` said maximum instead of minimum.

**Applied and item effects**
* Fixed: a change using `@targetUuid` more than once had only the first replaced, and `@targetActorUuid` (or any reference starting `@target`) was corrupted into the target's token id; every target reference is now replaced and `@targetActorUuid` is the target actor's uuid.
* Fixed: an effect added to or duplicated on an item had its `##` references turned into `@` at once, so they were later filled from the caster (Legacy, Origin) instead of left for the target; `##` is now converted only on an effect being applied (to an actor, or an applied enchantment).
* Fixed: an item change (an enchantment, e.g. `system.description.value`) turned `@UUID[...]` links into `##UUID[...]`; the links are now kept.
* Fixed: an effect expired under *Mark Expired*/Suppress (disabled, kept) gave its macro's "off" call `expiry-reason` `effect-disabled`; the call now gets the expiry's own reason (a special duration, `duration-expired:<event>`), as a deleted effect's does.
* Fixed: creating an effect on a creature whose token isn't drawn (another level, a scene not being viewed) logged `_preCreateActiveEffect Cannot read properties of null` and skipped preparing the effect's change values; DAE now prepares them without a drawn token.
* Fixed: an effect whose duration ran out with time passing outside combat reported `expiry-reason` `duration-expired:turnStart` (the Turn Start expiry dnd5e gives every finite duration); the reason is now `duration-expired:updateWorldTime`.

### 14.0.19

**Applied and item effects**
* Fixed: an effect applied from a temporary item (a CAT/CPR synthetic roll, a used-up consumable) lost its macro changes (`macro.actorUpdate`, `macro.itemMacro`, …).
* Fixed: an applied effect with an expiry event but no duration took the activity's duration (a Turn End effect from a 1-minute spell lasted a minute); it now inherits only when it has neither.

**Effect expiry**
* Fixed: an effect whose own *Expiry Mode* is Suppress was flagged expired under *Mark Expired*, so dnd5e deleted it once out of combat; it is disabled instead.
* Fixed: an effect's own *Expiry Mode* was missed or misapplied when expiry refreshes overlapped (a combat turn also advances world time), and a delete or update made during a refresh could be taken for an expiry; it now applies to just the effects that refresh expires, and also under *Do Nothing*; a dependent ending with its concentration is deleted, not suppressed.
* Fixed: a duration in rounds or turns ending at Round End, or at a Turn End on the round's last turn, ended a round (or turn) early: the new round's world time advance counted first. A 1-round Round End effect ends at the end of the round after its duration has run out.
* Fixed: migrating deprecated special durations gave the expiry to combatEnd over a source/target entry, which was then left doing nothing; and kept an entry the expiry already held (combatEnd on an effect with a duration stays).
* Fixed: an expired effect whose combat had been deleted was kept if its actor was in the combat being viewed.
* Fixed: opening an effect in the editor replaced its expiry event with a deprecated special duration (Target Turn Start + combatEnd became Combat End) and failed to open a locked compendium effect.
* Fixed: a deprecated combatEnd became the expiry event of an effect with a duration, so 1 minute + combatEnd lasted until the combat ended; it stays a special duration.
* Fixed: a special duration didn't end an effect under concentration when the two durations were in different units (rounds and minutes).
* Fixed: `hasExpiry`/`hasDuration` were false for an effect with only an expiry event and true for one with no duration.
* Fixed: *Expire Round Effects on Combat End* could delete an effect dnd5e was already deleting, and ended round effects from another combat when a combatant left.
* Fixed: under *Mark Expired* an expired effect applied by an activity (not under concentration) was never deleted, outside combat or when the combat ended.
* Fixed: an applied effect with Elapsed Time and no duration ended at the next event; it takes the activity's duration.

### 14.0.18

**Applied and item effects**
* Fixed: with *ATL compatibility* set to migrate or full, `ATL.*` keys with no `token.*` equivalent (width, height, depth, shape, elevation, hidden, rotation) were deleted from effects; they are kept for the ATL module.
* Added: `dae.eval(…)` in a dnd5e formula field (HP bonuses, attack and save bonuses and the like) is evaluated when dnd5e evaluates the field, with its full roll data, so it can use derived values such as `@abilities.dex.mod` (e.g. `dae.eval(@abilities.dex.mod > 2 ? 2 : 0)` in an attack bonus). In number fields and flags it is still evaluated when the change is applied. `dae.eval` works in any formula (midi-qol [#1565](https://gitlab.com/tposney/midi-qol/-/issues/1565)).
* Added: the effect editor flags a conditional (`? :`) in a number or formula field; on Foundry 14 a bare conditional is not a valid formula, wrap it in `dae.eval(…)` (midi-qol [#1565](https://gitlab.com/tposney/midi-qol/-/issues/1565)).
* Fixed: `DAE.deleteActiveEffect` with an item's uuid missed the effects that item applied, whose origin is the item's effect (Slayer's Prey left the old target marked).
* Fixed: a boolean `flags.dae.stackable` (DAE's original checkbox) was treated as stacking; `false` now means *none* and `true` *multi*, with a deprecation warning.

### 14.0.17

**Effect keys and macros**
* Fixed: a `macro.itemMacro`, `macro.activityMacro` or `StatusEffect` change was dropped when another change in the same effect had an inline roll or `@actorUuid`/`@tokenUuid` replaced.
* Fixed: `macro.actorUpdate` ignored a value of 0 or false; did not restore the original value on removal unless an undo argument was given; `each` lost the original value and ignored the current one; and dice in the value were not rolled.
* Fixed: `macro.createItemRunMacro` called the created item's macro with `on` instead of `onCreate`.
* Fixed: `system.attributes.movement.hover` with the text `false` turned hover on.
* Fixed: `system.tools.all` added entries for tool categories, which stopped the actor preparing.
* Fixed: a `DamageBonusMacro` of `ActivityMacro` used the item's macro instead of the effect's activity.
* Removed: copies of the activity macro into effect flags that nothing read.
* Fixed: `token.*` keys (light, sight, texture, disposition, ring…) were missing from DAE's change key list on Foundry 14; detection modes other modules register also get `.enabled` as well as `.range`.

**Applied and item effects**
* Fixed: adding or removing an item with an Active Auras aura set to ignore its source stopped DAE processing that item's remaining effects.

**Enchantments**
* Removed: the times-up check before setting an applied enchantment's start time (times-up does not run on Foundry 14).

**Expiry and durations**
* Fixed: DAE warned that an effect's `combatEnd` special duration was deprecated even when the effect's expiry was already set to another event, which leaves `combatEnd` nowhere else to go (midi's reaction and bonus action markers).
* Changed: outside combat, time passing now ends an effect whose expiry event has no duration (e.g. *Turn Start*), as Foundry does; only *Combat Start* waits for a combat.
* Changed: as in dnd5e 6, an effect created in combat with a duration in rounds or time units and no expiry event gets *Turn Start*, so it lasts until that turn rather than ending as the round turns over. Applied effects that take the activity's duration no longer get *Elapsed Time*.
* Changed: as in dnd5e 6, a combatant leaving the combat, or the combat ending, removes its *Source/Target Turn* expiry effects from that combat.
* Fixed: a *Turn Start* or *Turn End* effect never expired once the combatant whose turn it waited for had left the combat.
* *Expire Round Effects on Combat End* no longer ends effects whose duration is in time units (minutes, hours...).
* Changed: as in dnd5e 6, an effect marked expired (*Mark Expired*) is kept only while its actor is in the combat it expired in; it is deleted when the actor leaves that combat or the combat ends, and at once if it expires outside combat.

**Effect editor**
* Fixed: DAE's effect editor would not open for a change whose key has a numeric forced mode (such as midi's ActivityOverTime, registered with -1).
* Fixed: DAE's effect editor skipped its base sheet's render step, so read-only viewers got an editable-looking form.

**Foundry 14 compatibility**
* Deletions use Foundry 14's `ForcedDeletion` instead of the `-=` key syntax, which Foundry 14.369 warns about.

**Removed**
* Removed the unused *Just Icon* setting.

### 14.0.16
* Fixed: `system.bonuses.All-Attacks`, `All-Damage` and the `weapon`/`spell` attack and damage bonus keys had no effect in 14.0.15. They were written to dnd5e 6's `system.rolls.*` paths, which dnd5e 5.x does not read; they add to `system.bonuses.<mwak|rwak|msak|rsak>.<attack|damage>` again. The `system.rolls.*` keys are no longer offered.

### 14.0.15
* Requires Foundry 14.368 (verified 14.368).
* Bare dice in a field worked out without dice when the actor is prepared - a number field, or a deterministic formula field such as `system.attributes.ac.bonus` or `system.attributes.hp.bonuses.overall` - become a silent inline roll (`+2d8` becomes `+[[[2d8]]]`) when an effect is created or edited on an actor or owned item, so they are rolled once instead of counting as 0. Roll-time formula fields keep their dice.
* `system.attributes.hp.bonuses.overall` and `.level` are dnd5e's formula fields again; DAE had replaced them with a text field.
* A max HP change whose id is listed in the effect's `flags.dae.raiseCurrentHp` also raises current HP by the same amount, once per effect, when it starts applying (effect created on a token's actor, item gained, or an unlinked NPC token placed with its hit points rolled). When it stops, current HP above the new maximum is lost; it never lowers current HP.
* An effect whose `flags.dae.enableCondition` becomes false ends as an expired effect does: deleted, or under the *suppress* expiry mode disabled and enabled again when the condition holds.
* Readme: a *Maximum hit points* section - which key to use for Aid-style bonuses, a character's calculated max, an NPC's rolled hit points, or a fixed max.
* A `StatusEffect` change removes its condition when the change is deleted or edited, or its effect is disabled; the condition was left on the actor.
* Macros, `StatusEffect` and Convenient Effects changes are undone when their effect is suppressed (e.g. unequipping the item) and redone when it is unsuppressed; the work stayed in place. Macros see `expiry-reason` `effect-suppressed` / `effect-unsuppressed`. This runs on one client: the active GM, or the actor's first active owner when no GM is connected. New hook `dae.suppressionChanged(effect, suppressed)`.
* Breaking: the **Display results of inline rolls** setting is removed. `[[expr]]` in a change value always posts its roll to chat; `[[[expr]]]` rolls without a chat message. Effects using `[[expr]]` that relied on the setting being off (the default) should switch to `[[[expr]]]`.
* `dae.roll(expr)` is deprecated: it becomes a silent inline roll, `[[[expr]]]`, when the effect is created or edited on an actor or an owned item. A `dae.roll` still reached when an actor is prepared counts as 0, as before.
* Inline rolls in a transfer effect are rolled when the item lands on an actor (created, dragged from another actor, duplicated) and when the formula is edited. The formula stays in the effect and the totals are stored in `flags.dae.inlineRolls`, so dragging the item to another actor rolls again; previously the roll waited for the effect to be edited and then replaced its formula.
* Dependent effects (e.g. of concentration) follow their parent being disabled or suppressed when the parent's actor has no token on the scene, and when a player toggles their own effect whose dependents they cannot update (the GM updates those).
* `@UUID[...]` links in an effect applied to an actor are kept; they came out as `0[...]`.
* An explicit `token.sight.*` change (e.g. saturation) wins over the vision mode's defaults whatever order it is written in; written before `token.sight.visionMode` it was overwritten. DAE no longer adds the defaults itself; core does.
* `##` deferred references are restored on effects that reach an actor without DAE's apply path (dnd5e's chat-card apply, enchantments, a dragged effect); they were left as `##` and the change skipped.
* Effect editor: the DIME button's tooltip shows "DIME" instead of `dae.DIMEditor.Name`.
* Deprecated special durations that don't fit core's single expiry (e.g. combatEnd alongside turnStart) are kept rather than dropped, and an explicitly set expiry is not overwritten.

### 14.0.14
* Minimum Foundry raised to 14.365, verified to 14.367.
* Phase correction now uses Foundry's `ActiveEffect#shouldApplyChange`, so a change applied in its field's phase rather than its stored phase takes part in core's priority sort instead of being applied after it.
* `@stackCount` now resolves at every occurrence in a change value, not just the first.
* Arithmetic in a numeric flag's value is now evaluated (`floor(@details.level/2)` no longer becomes 0). Formula-valued flags such as midi optional bonuses keep their string.
* Special durations: the source/target start/end expiries are evaluated the way dnd5e 6.0 does on earlier dnd5e versions too.
* Special durations: a source/target end expiry no longer ends on the turn the effect was applied.
* Special durations: source/target expiries keep their own value instead of being rewritten to `turnStart`/`turnEnd` with a fixed combatant.
* Rider conditions are left to dnd5e, which creates them itself on effect creation; DAE's duplicate call used an API deprecated in dnd5e 6.0.
* The macro-init enchantment guard uses `applicableType`, so riders of non-applied enchantments are skipped too.
* midi's special durations are no longer registered by DAE; midi registers them itself via `dae.addSpecialDurations`. DAE's duplicate list ran after the hook and overwrote midi's, which is how the mis-spelled concentration-failure entry reached the UI. DAE now defines only system-agnostic entries.
* Re-enabling a transfer effect no longer stamps a start on it, so a duration on a transfer effect never runs. A transfer effect is the definition on the item, and a start makes it expiry-tracked, after which the system deletes it off the item. Legacy items that toggled such an effect on and relied on it expiring must add the effect to the activity's Effects list instead; see the midi-qol changelog.
* `_prepareDuration` no longer special-cases an effect that has an expiry and no duration value; dnd5e 6.0 already prepares those as infinite, and the special case skipped dnd5e's own duration labels.
* Per-change `conditions` on an effect change are now honoured, and `change.applied` is set. DAE decided the application phase and returned without letting the system run its own checks, so dnd5e's per-change conditions and effect-level condition suppression were skipped for every keyed change. DAE still chooses the phase, then delegates.
* Bonus selectors expand to `system.rolls.attack|damage.<type>.bonus`, the dnd5e 6.0 location, instead of the old `system.bonuses.<type>.<attack|damage>` paths that only still resolve through the system's deprecation shim.
* `system.bonuses.All-Attacks` now sets dnd5e's own `system.rolls.attack.bonus`, which the system combines into every attack roll, rather than writing each attack type separately.
* New selector keys for the groupings dnd5e has no native equivalent for: `system.rolls.attack.weapon.bonus`, `.spell.bonus`, and `system.rolls.damage.all|weapon|spell.bonus`. The `system.bonuses.*` forms keep working as aliases.
* Using a legacy `system.bonuses.All-Attacks`-style selector logs a deprecation warning naming its replacement.
* An effect that inherits its duration from the activity/item now gets an `updateWorldTime` expiry, instead of only expiring on the round tick.
* Effect editor: set-backed fields on an actor's effects (`system.damage.base.types` and other item/activity Set fields) are no longer locked to override - they default to add with every mode selectable. 14.0.13 fixed this for item and enchantment effects only.
* Effect editor: change modes are no longer restricted for fields with a value picker; v14 implements all six modes on Set fields, so only the default is set.

### 14.0.13
* Effect editor: each change row now has an editable Phase dropdown (defaults to the field's phase, and re-defaults when you change the change's key). Your choice wins at apply time, including forcing initial on a normally-final field.
* Effect editor: fixed the change row wrapping the delete icon onto the next line.
* Effect editor: widened the default window and fixed horizontally scrolling the changes list clipping the right-hand columns.
* Status reconciliation: removing a status effect no longer errors when a concurrent call already deleted it.
* Set-backed fields (damage types, traits, and any other Set-valued field): the "-value" removal options are now offered in add mode, not just custom.
* Enchantment/item effects: system.damage.types, system.damage.base.types and the save ability (activities[save].save.ability) now allow all change modes instead of being locked to override.
* Custom-mode handling now ignores non-custom changes, so an unrecognised change type on a flag/macro key is no longer mis-applied as custom.
* Special durations: on dnd5e 6.0+, effects expiring out of combat (including at combat end) are now deleted immediately instead of left marked-expired.
* Deprecated special-duration names (turnStart/turnEnd and their Source variants) now migrate to source/target expiry on dnd5e 6.0+ too, preserving the source/target distinction.

### 14.0.12
* Harden item spec building - spec generation for one item type can no longer break others.
* Enchantment effect configs fall back to union specs and render degraded instead of erroring when specs are missing.
* The joinCombat special duration label now uses its own localization key (dae.joinCombat) instead of borrowing a core Foundry string.
* Set-backed trait fields (e.g. system.traits.dr.value) in the effect editor are no longer forced to override mode. They default to add (which preserves existing entries) with the change type left selectable; use subtract to remove. The "-value" removal options are shown only in custom mode, and the value list now refreshes when you change the mode.

### 14.0.10
* Fix for macro.createItem not deleting items on unequip etc.
* New world setting **"ATL → token.* migration policy"** (`dae.atlCompatibility`) for switching DAE to Foundry v14's native `token.*` active-effect routing. Default `legacy` keeps current behavior (ATL.* keys handled by the ATL module). Other modes:
  - `runtime` — rewrite ATL.* keys to token.* at apply time only; saved effects are untouched
  - `migrate` — one-shot bulk migration of world data + non-published-module compendiums, plus pre-write normalisation for new content. Locked compendiums are skipped with a console log
  - `full` — `migrate` plus runtime fallback for unmigrated content, and auto-unlock/relock of locked compendiums during migration
* Directly mapped ATL keys: alpha, light.* (angle, attenuation, bright, color, coloration, contrast, dim, luminosity, saturation, shadows, darkness.min, darkness.max), sight.* (angle, attenuation, brightness, color, contrast, enabled, range, saturation).
* Expanded with care: `ATL.light.alpha` (squared at migration to match ATL's runtime), `ATL.light.animation` (JSON unpack into per-field sub-keys with the same fixer ATL uses for malformed JSON), `ATL.sight.visionMode` (also emits per-default sub-keys from `CONFIG.Canvas.visionModes[X].vision.defaults`), `ATL.detectionModes.<id>.range` (emits paired `enabled: true` + `range` so the TypedObjectField entry materialises correctly), `ATL.preset` (full preset unpack into multiple token.* changes), legacy `ATL.dimSight`/`ATL.brightSight` (jumps directly to `token.sight.range`/`brightness`).
* Not migrated (require ATL on v14 until core or dnd5e fills the `_onOverrideSize` gap): `ATL.width`, `ATL.height`, `ATL.depth`, `ATL.shape`, `ATL.elevation`, `ATL.hidden`, `ATL.rotation`. A one-shot console warning per unsupported key tells the user which effects still need ATL.
* `token.sight.visionMode` active-effect changes now auto-apply the mode's visual defaults (saturation, contrast, brightness, attenuation) as sibling overrides at apply time. 

### 14.0.9
* Fix for package release fails

### 14.0.8
* Active effect change rows now preserve newlines and indentation. Previously, opening an effect sheet with a multi-line change value (such as `flags.dae.macro.command`) collapsed the value to a single line and saving the sheet permanently destroyed the source formatting.
* Macro change rows (`flags.dae.macro.command` and the `flags.itemacro.macro.*` variants) now show an edit button that opens the DIME macro editor on the change value, giving syntax highlighting and a full-size code editor without leaving the effect sheet.

### 14.0.7
* `flags.dae.showIcon` is now auto-migrated to the native `ActiveEffect.showIcon` field when effects are created. Existing effects show a deprecation warning during actor recalculation and are migrated when opened in the effect editor.
* Deprecated special durations (`turnStart`, `turnEnd`, `turnStartSource`, `turnEndSource`, `combatEnd`) are auto-migrated to `duration.expiry` on effect creation.
* New migration system: "Migrate Now" button in DAE settings scans all world actors, items, scene tokens, and compendium packs for deprecated effect data and updates it. Includes an "Auto-migrate on update" setting.
* Migration covers: `flags.dae.showIcon`, deprecated special durations, old `data.` prefix change keys, field mappings (`StatusEffect`, `system.traits.d*.all`), and `flags.midi-qol.optional` keys missing `.all` suffix.
* Migration API exported on `game.modules.get("dae").api`: `migrateEffectData`, `migrateActor`, `migrateItem`, `migrateWorld`.
* Fix effect config crash (`forcedMode.toLowerCase is not a function`) when modules register specs with numeric mode values. Numeric modes are now mapped to their v14 string equivalents.
* Fix effect config dropdown not showing the correct selected value when reopening (e.g. damage type always showing "All Damage"). The `selected` attribute now survives HTML serialization.
* Fix effect config setting `flags.dae.stackable` in memory during render, which prevented the stacking mode from being saved when editing compendium effects.
* Fix for token effects being applied twice in some cases.
* Fix for duplicate display of ac attribution.

### 14.0.6
* Fix for visibility height errors

### 14.0.5
* Fix `macro.createItem` rejecting items with advancements. Advancements are now stripped from temporary items to prevent orphaned grants on level-up.
* Export `allMacroEffects` and `macroDestination` on the DAE API for external module use.
* Remove obsolete `OwnedItem` origin migration and `tobMapper` utility from API.
* Removed dead Foundry v12/v13 version checks and pre-5.3 dnd5e compatibility code.
* Removed unused stub functions and armor migration functions.
* Consolidated duplicate trait handlers (`.all`, `.custom`, `armorProf.all`/`weaponProf.all`) in custom effect processing.
* Added `getItemMacroCommand()` utility and `CREATE_ITEM_KEYS` Set for cleaner macro command resolution.
* Filter effects before cloning in `applyActiveEffects` to avoid unnecessary deep copies.
* Fix typo in compendium cleanup notification.
* Inject `expiry-reason` into core v14 duration expiry operations. Foundry v14's `ActiveEffectRegistry.refresh()` does not pass any reason when expiring effects — DAE now injects `expiry-reason` into the delete/update options so macros and hooks can determine why an effect was removed. Migration from v13 times-up reasons:

```
  v13 (times-up)                      v14 (DAE)
  times-up:expired                    duration-expired:updateWorldTime (or duration-expired:{event})
  times-up:turnStart                  duration-expired:turnStart
  times-up:turnEnd                    duration-expired:turnEnd
  times-up:turnStartSource            duration-expired:turnStart:source
  times-up:turnEndSource              duration-expired:turnEnd:source
  times-up:expired:combat-end-rounds  dae:expired:combat-end-rounds
```

* Fix `expireEffects()` not passing context to transfer effect disable and enchantment delete paths — `expiry-reason` was lost for those expiry routes.
* Fix `expireEffect()` not passing options to transfer effect update path.
* Consolidated effect change processing into `processEffectChanges()`, removing nested `actionQueue` calls that could deadlock.
* Significant changes to dae's processing of effect expiry. 
  - Generally all time/turn start/end expiry is handled by core foundry and not dae. Dae enhances core foundry to allow you to modify which combatants turn is recorded for turn start/end effect expiry. Core foundry always records the current combatant as the start.combatant, dae allows you to choose current combatant, the source of the effect being created or the target of the effect, allowing effects to expire on the source or targets turn start/end.
    - the old dae special durations for turn start/end are now deprecated and will throw a deprecation warning. If you edit the effect dae will migrate the data fo
  - Since core foundry deals with time based expiry so well there is no duration mapping on combat start/end or when applying effects. The effect/item duration is always used for the duration on the created effect.
  - dae adds an additional expiry event timeElapsed which indicates an effect only requires a duration expiry for the effect to expire.

### 14.0.4
* Fix TypeError when `customStats` is not iterable in `isSuppressed` for Group actors without `system.traits.ci.custom` (MR [!157](https://gitlab.com/tposney/dae/-/merge_requests/157), thanks @thatlonelybugbear).
* Correct descriptions for shimmed enchant keys — swap `system.damage.bonus`/`system.damageBonus` descriptions and replace "Should use … instead" with "Equivalent to …" for attack shim keys (MR [!159](https://gitlab.com/tposney/dae/-/merge_requests/159), thanks @Michael Roth).
* `@activity` is now available in AE change value formulas when effects are applied via an activity (inspired by MR [!156](https://gitlab.com/tposney/dae/-/merge_requests/156), thanks @thatlonelybugbear).
* Fix for token.xxxx effects not working.

### 14.0.0
* Added ability to specify source or target combatant in effect duration fields
* Foundry v14 showIcon replaces dae's show icon on active effects.
