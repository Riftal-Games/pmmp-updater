# 002 BedrockData sources

Date: 2026-11-10
Status: accepted
Milestone: M1
Issue: pmmp-updater#3

## Context

Each version run has to regenerate `packages/bedrock-data` without pmmp's
bds-modding-devkit, whose BDS mod hooks functions by names the Linux binary does not
carry (ADR 001). This ADR measures four sources: `Mojang/bedrock-samples`
(`metadata/vanilladata_modules/`), BDS's Script API, packets BDS sends to a client, and
the block network IDs BDS sends with `block-network-ids-are-hashes=false`. A fifth,
Mojang's protocol docs, is read and not measured. This ADR names the source of every
file, so a run knows where each comes from and which files it cannot yet produce.

## Measured: bedrock-samples v1.26.60.5 against bedrock-data 1.26.60.6 (protocol 2225)

`node tools/bds/samples.js` on 2026-11-10, in WSL `Ubuntu-26.04`, reports MISMATCH for
both tables it derives and exits 1.

- **Block states.** Samples give 1466 block names and 24058 states; ours has 1480 and
  23960. 23924 states are in both. The tool orders blocks by FNV-1 64 of the name, the
  order BDS gives block network IDs in (`tools/bds/samples.js:102-115`).
  - 14 names (36 states) are only in ours, all technical, legacy or education blocks:
    `end_gateway`, `info_update`, `info_update2`, `stonecutter`, `invisible_bedrock`,
    `glowingobsidian`, `chalkboard`, `client_request_placeholder_block`, `reserved6`,
    `deprecated_anvil`, `moving_block`, `deprecated_purpur_block_1` and `_2`,
    `netherreactor`. Samples say nothing about why they are left out, so this difference
    is unexplained.
  - 134 states are only in samples, in 8 blocks. Samples list a property's values once
    for every block, so blocks that use fewer get too many: the three powered rails'
    `rail_direction` 6 to 9, and `age` or `growth` above the real maximum for
    `chorus_flower`, `cocoa`, `frosted_ice`, `nether_wart` and `shelf_mushroom`.
  - The shared states first stand in a different order at shared state 79, in
    `warped_door`: samples give `door_hinge_bit=b:1`, `cardinal_direction=s:"south"`,
    ours `door_hinge_bit=b:0`, `cardinal_direction=s:"west"`. Samples give no property
    order, so the tool chooses one: it sorts each block's properties by name
    (`tools/bds/samples.js:118`) and takes each property's values in samples' single
    global order (`tools/bds/samples.js:121`). BDS orders properties and values per
    block, so no order derived from samples can be trusted to give network IDs.
  - Samples carry no state `version`.
- **Items.** Samples list 1627 items, every one in `required_item_list.json` with the same
  network ID. Ours has 2081. The 454 more are 376 named as a block and 78 others: legacy
  aliases such as `log` and `wool`, education items, and `item.*` names. Samples carry
  no `component_based`, `version` or `component_nbt`.

Samples cannot reproduce either file. That is the first half of the condition the
steward's ruling on #3 (issuecomment 6761625992, last paragraph) sets for reversing its
sections 2 and 3. The second half is a capture that cannot supply
`canonical_block_states.nbt` either, which the ruling's section 2 and ADR 001 already
expect, because `StartGamePacket` carries only the data-driven blocks and a checksum.
PR 3 measures it. With both halves, the ruling brings `canonical_block_states.nbt` back
to the steward before the Windows BDS or the Ghidra route in #5 is taken.

## Measured: Script API, BDS 1.26.60.6 and 1.26.63.1

`node tools/bds/script.js` on 2026-11-13 reports MISMATCH, identical for builds 52886190
(1.26.60.6) and 53340802 (1.26.63.1): 1480 block names, all ours, in 23942 states to our
23960. 39 state names ours lacks, such as `color` on flattened blocks, sit in 4715 of
those 23942 states; dropping those names merges no two states. Then 18 of our states are
missing: `chalkboard` `direction` 4 to 15 and `creaking_heart` `awake`. The pack tries
only the values BlockStates lists for each state name, and keeps a state only when it
resolves unchanged. Its log gives one total of refused states, so it cannot tell a value
never listed from one listed and refused, and it does not show that BDS lacks these 18.
No state `version`, and no order: the API has no network ID, and the pack's own order
first differs inside `leaf_litter`.

## Measured: BDS packets, BDS 1.26.60.6 and 1.26.63.1, with our own server as control

`node tools/bds/decode.js --capture <capture.bin>` on 2026-11-13, in WSL `Ubuntu-26.04`,
re-decodes the runner's cached captures with `packages/bedrock-protocol` 1.26.60 (protocol
2225) in `local-pocketmine-mp:latest` (`sha256:fe69b3c5...`) and compares all 19 packet
rows with `packages/bedrock-data` 1.26.60.6 (protocol 2225). Each capture exits 1.

- **Captures.** BDS Linux 1.26.60.6 (Build ID 52886190) and 1.26.63.1 (53340802), each
  recorded by `record.js` over NetherNet on the isolated network, since BDS refuses RakNet
  logins (ADR 003). After the header their reports are equal line for line, so no packet
  row changes from 1.26.60.6 to 1.26.63.1.
- **Block network IDs.** Both ran with `block-network-ids-are-hashes=true`, asserted by
  `run.sh` and sent in `StartGamePacket`. Each ID is matched with FNV-1a 32 of a state in our
  `canonical_block_states.nbt`. All 1065 in `CreativeContentPacket` and all 2506 in
  `CraftingDataPacket` name one state of the item's own block.
- **Recipes** take the form of pmmp-core's `tools/generate-bedrock-data-from-packets.php`.
  As there, an ingredient's meta becomes a state through our `block_state_meta_map.json`
  and `block_id_to_item_id_map.json`, so those two files are inputs here.
- **Control.** Our `local-pocketmine-mp` above, over RakNet, sends sequential IDs, each
  taken as an index in our file. All 1069 and 1421 name a state of the item's own block. It
  MATCHes the six rows pmmp-core sends as stored, and `potion_container_change.json`. It
  differs on the rows pmmp-core rebuilds:
  - creative: it leaves out items and icons it does not register and re-encodes block states
    (`src/inventory/CreativeInventory.php:66-73`), and tags every group icon
    `___GroupBugWorkaround___` (`src/network/mcpe/cache/CreativeInventoryCache.php:141`);
  - recipes: it reads shaped recipes of `crafting_table` only, shapeless, potion type and
    container change recipes, skipping any with an item it does not register
    (`src/crafting/CraftingManagerFromDataHelper.php:209-331`). It sends each with priority
    50, no unlocking ingredients and as symmetric, sends furnace recipes as shapeless, and
    sends no other kind (`src/network/mcpe/cache/CraftingDataCache.php:81-210`). Read that
    way, 819 of its 964 shaped and 1272 of its 1425 shapeless entries equal ours. The rest
    differ in output `block_states` (257) or `nbt` (41), 26 of them in an input's `meta` too.
  - So on those rows the control shows pmmp-core, and BDS stands alone: every creative item
    and recipe BDS sends is one of ours, in our order. An extraction fault would show
    entries only in the capture. There are none.
- **Education features**, off in both BDS runs and on in pmmp-core's `StartGamePacket`.
  Every creative item and recipe of ours that BDS leaves out, outside the next point, names
  an Education Edition item: elements, compounds, chemistry tables, `bleach`, hard glass,
  glow sticks. Consistent with the setting, not confirmed: no BDS run with it on exists, and
  the control cannot confirm it, since pmmp-core rebuilds creative and recipes from ours.
- **Ice content, not explained.** Ours has `ice_ball`, `icicle`, `ice_crystal`,
  `frostbite` and its spawn egg, potions 47 and 48 (47 is brewed from `ice_ball`), arrows 48
  and 49, and the `ice_caves` biome. BDS leaves all of them out of creative, recipes, biomes
  and actors. Its item table has no `ice_ball` and gives `icicle` and `ice_crystal` the
  non-component IDs -1247 and -1248, so 32 items sit 3 lower. Both runs had no experiment
  on, and what brings this content in is unknown.
- **Order, not explained.** `entity_identifiers.nbt` and `jigsaw_structures_data.nbt` hold
  the entries ours holds, equal entry for entry, apart from `frostbite`, in another order.
  A scratch decode of both NBT trees outside the repository found this; the tool compares
  their sha256.

## Measured: sequential block network IDs, BDS 1.26.60.6

With `block-network-ids-are-hashes=false`, BDS numbers block states from 0 up, as the
client and pmmp-core do from our file, so the ID BDS sends for a state would be its index
in `canonical_block_states.nbt`. BDS Linux 1.26.60.6 (Build ID 52886190) ran three ways
with that setting: sent sub-chunks, one state placed at a time, and one-block structures.
The tooling is not committed, because the route closed. These figures rest on the
steward's two rulings on #3, issuecomment 6868011006 and 6868976682, each re-derived with
the steward's own readers, and on no committed tool.

- **Our file** has 23960 entries, all `version` 18168865. BDS's structure palette in the
  saved level equals it as a set: name, states in order with their tag types, and
  `version` (6868011006).
- **Sent sub-chunks** (6868011006). IDs 0 to 23959, 21282 distinct. 21205 states were
  sent at their index in ours, 2755 not. Of the 2755:
  - 2721 are the same block, differing only in states BDS derives from neighbours or
    support: stairs `corner`, `redstone_wire` `redstone_signal`, and the
    `minecraft:connection_*` states of fire, `chorus_plant`, fences, panes, bars and
    `trip_wire`, among others. Fire differs in its connections, never in `age`;
  - 4 are beds sent as `minecraft:air`;
  - 30 were sent as `minecraft:unknown`.
- **One state at a time** (6868976682). 23960 states placed at 23959 positions gave 48485
  block updates, IDs 0 to 23959.
  - The first update at each placed position names the placed block for 23863 states.
    The other 97: the 30 unknowns, `flowing_lava` and `flowing_water` sent as `lava` and
    `water` (16 each), `fire` and `soul_fire` sent as air (16 each), `bubble_column` sent
    as air (2), and the one reused position (1).
  - 17754 distinct IDs are sent in any update, and **6206 of the IDs 0 to 23959 are never
    sent**. The first updates hold 17753 distinct IDs, 1111 of them first at more than one
    position.
  - The 6206 by block: stairs 3104, `redstone_wire` 1215, fences, panes and bars 855,
    `fire` 496, `trip_wire` 240, fence gates 104, and the rest as listed in 6868976682.
- **One-block structures** (6868976682). 6217 IDs never sent, 17742 distinct first IDs,
  1113 of them first at more than one position.
- **The 30 unknowns, not explained.** `icicle` 20, `ice_crystal` 6 and `disc_press` 4. In
  both placement runs every position where one was placed got ID 11244, which is
  `minecraft:unknown` in ours, and none of the 30 IDs ours gives those states was sent
  anywhere. The Script API saw them with no states (`minecraft:icicle{}`). No experiment
  and no education features were on.
- **MISMATCH.** The map from placed state to sent ID is many to one, not a reordering,
  which fits states BDS reshapes once placed and not a different order. The completeness
  rule, every ID from 0 to the highest exactly once (6847007952, section 1, rule 3),
  fails, and the 1.26.60.6 control is not equal to ours entry for entry.
- **What the runs show.** BDS honours the setting, with IDs from 0 within 0 to 23959. No
  placed state was sent as an unrelated block. The structure palette equals ours as a set.

## Decision

| File | Source | Measured |
|---|---|---|
| `canonical_block_states.nbt` | neither: samples MISMATCH, missing 14 blocks with no stated reason and giving no state order; Script API MISMATCH, 39 state names ours lacks, 18 of our states missing, no order or `version`; packets carry only the data-driven blocks and a checksum (ADR 001); sequential block network IDs tried and failed, MISMATCH, 6206 IDs never sent, 30 states sent as unknown, not explained. Each version's file comes from #10's delta route | samples, Script API and the three sequential block network ID runs, above |
| `required_item_list.json` | BDS packets, `ItemRegistryPacket`; samples MISMATCH, a subset whose 1627 IDs agree | samples, above; BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, no block IDs: MISMATCH, 41 differences, all from ice content, not explained; control MATCH |
| `data_driven_blocks.nbt` | BDS packets, `StartGamePacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, no block IDs: MATCH; control MATCH |
| `creative/construction.json` | BDS packets, `CreativeContentPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, block IDs by FNV-1a 32, all resolved: MISMATCH, 567 of our 686 items in our order, the 119 left out education, not confirmed; control differs as pmmp-core rebuilds it |
| `creative/equipment.json` | BDS packets, `CreativeContentPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, block IDs by FNV-1a 32, all resolved: MISMATCH, 367 of our 370 items in our order, the 3 left out ice content, not explained; control differs as pmmp-core rebuilds it |
| `creative/items.json` | BDS packets, `CreativeContentPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, block IDs by FNV-1a 32, all resolved: MISMATCH, 607 of our 729 items in our order, the 122 left out education, not confirmed; control differs as pmmp-core rebuilds it |
| `creative/nature.json` | BDS packets, `CreativeContentPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, block IDs by FNV-1a 32, all resolved: MISMATCH, 439 of our 448 items in our order, the 9 left out ice content, not explained; control differs as pmmp-core rebuilds it |
| `recipes/potion_container_change.json` | BDS packets, `CraftingDataPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, no block IDs: MATCH, 2 entries; control MATCH |
| `recipes/potion_type.json` | BDS packets, `CraftingDataPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, no block IDs, meta by our meta map: MISMATCH, 210 of our 213 in our order, the 3 left out `ice_ball`, not explained; control differs as pmmp-core rebuilds it |
| `recipes/shaped_crafting.json` | BDS packets, `CraftingDataPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, output block IDs by FNV-1a 32, all resolved, input meta by our meta map: MATCH, 1219 entries in order; control differs as pmmp-core rebuilds it |
| `recipes/shaped_crafting_asymmetric.json` | BDS packets, `CraftingDataPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true: MISMATCH, none sent, all 128 of ours education, not confirmed; control sends none |
| `recipes/shapeless_crafting.json` | BDS packets, `CraftingDataPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, output block IDs by FNV-1a 32, all resolved, input meta by our meta map: MISMATCH, 2068 of our 2128 in our order, the 60 left out education (`bleach`), not confirmed; control differs as pmmp-core rebuilds it |
| `recipes/shapeless_shulker_box.json` | BDS packets, `CraftingDataPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, output block IDs by FNV-1a 32, all resolved, input meta by our meta map: MATCH, 1456 entries in order; control sends none |
| `recipes/smithing.json` | BDS packets, `CraftingDataPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, output block IDs by FNV-1a 32, all resolved, input meta by our meta map: MATCH, 12 entries in order; control sends none |
| `recipes/smithing_trim.json` | BDS packets, `CraftingDataPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, no block IDs: MATCH, 1 entry; control sends none |
| `recipes/special_hardcoded.json` | BDS packets, `CraftingDataPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, no block IDs: MATCH, 14 entries in order; control sends none |
| `biome_definitions.json` | BDS packets, `BiomeDefinitionListPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, no block IDs: MISMATCH, only ours has `ice_caves`, ice content, not explained; control MATCH |
| `entity_identifiers.nbt` | BDS packets, `AvailableActorIdentifiersPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, no block IDs: MISMATCH, only ours has `frostbite`, and the other 138 stand in another order, not explained; control MATCH |
| `jigsaw_structures_data.nbt` | BDS packets, `JigsawStructureDataPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, no block IDs: MISMATCH, our 64 pools in another order, not explained; control MATCH |
| `voxel_shapes.json` | BDS packets, `VoxelShapesPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, no block IDs: MATCH; control MATCH |
| `protocol_info.json` | Mojang docs: protocol number and packet IDs | no |
| `enums/ParticleType.json` | Mojang docs, read by `enums.py` | no |
| `enums.py` | Mojang docs: the script that reads them for `enums/` | no |
| `biome_id_map.json` | samples, `mojang-biomes.json` lists name and ID | no, `samples.js` does not compare it |
| `block_state_meta_map.json` | neither. #5 | no |
| `block_properties_table.json` | neither. #5 | no |
| `block_id_to_item_id_map.json` | neither. #5 | no |
| `item_tags.json` | neither. #5 | no |
| `command_arg_types.json` | neither. #5 | no |
| `level_sound_id_map.json` | Mojang docs, the `LevelSoundEvent` enum | no |
| `entity_id_map.json` | neither: legacy save IDs, carried unchanged by the runbook. #10 | no |
| `r16_to_current_item_map.json` | neither: legacy map, carried unchanged by the runbook. #10 | no |
| `r12_to_current_block_map.bin` | neither: unused since PocketMine-MP 5, carried unchanged by the runbook. #10 | no |
| `banner_patterns.json` | neither: written by hand, kept by the runbook. #10 | no |
| `README.md` | package file, not data | n/a |
| `LICENSE` | package file, not data | n/a |
| `composer.json` | package file, not data | n/a |
| `.gitattributes` | package file, not data | n/a |
| `.minify_json.php` | package file, not data | n/a |

## Consequences

- **#3, PR 3** decodes a capture and fills in every row marked PR 3.
- **Samples** are checked, not trusted, for the two tables measured above: a version run
  may diff them against the capture, never use them alone. `biome_id_map.json` is the one
  file samples supply alone, and it stays unmeasured until a tool compares it.
- **`canonical_block_states.nbt`:** the reversal in the steward's ruling on #3
  (issuecomment 6847007952, section 1) fired, on the sequential block network ID
  MISMATCH above (6868976682, section 1), and its source stays neither. Each
  version's file comes from #10's route: our file plus a delta BDS measures, ruled on #10
  (issuecomment 6868986975).
