# 002 BedrockData sources

Date: 2026-11-10
Status: proposed
Milestone: M1
Issue: pmmp-updater#3

## Context

Each version run has to regenerate `packages/bedrock-data` without pmmp's
bds-modding-devkit, whose BDS mod hooks functions by names the Linux binary does not
carry (ADR 001). Three sources are open to us: `Mojang/bedrock-samples`
(`metadata/vanilladata_modules/`), packets BDS sends to a client, and Mojang's protocol
docs. This ADR names the source of every file, so a run knows where each comes from and
which files it cannot yet produce.

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
23960. 39 states ours lacks, such as `color` on flattened blocks, sit in 4715 of them;
dropping those merges none. Then `chalkboard` `direction` 4 to 15 and `creaking_heart`
`awake` are missing, 18 states: BlockStates lists `direction` as 0 to 3, and no `awake`
resolved unchanged. No state `version`, and no order: the API has no network ID, and the
pack's own order first differs inside `leaf_litter`.

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
  glow sticks. Explained by the setting; no BDS run with it on has confirmed it.
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

## Decision

| File | Source | Measured |
|---|---|---|
| `canonical_block_states.nbt` | neither: samples MISMATCH, missing 14 blocks with no stated reason and giving no state order; Script API MISMATCH, 39 extra states, 18 missing, no order or `version`; packets carry only the data-driven blocks and a checksum (ADR 001). Back to the steward before #5 | samples and Script API, above |
| `required_item_list.json` | BDS packets, `ItemRegistryPacket`; samples MISMATCH, a subset whose 1627 IDs agree | samples, above; BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, no block IDs: MISMATCH, 41 differences, all from ice content, not explained; control MATCH |
| `data_driven_blocks.nbt` | BDS packets, `StartGamePacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, no block IDs: MATCH; control MATCH |
| `creative/construction.json` | BDS packets, `CreativeContentPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, block IDs by FNV-1a 32, all resolved: MISMATCH, 567 of our 686 items in our order, the 119 left out education; control differs as pmmp-core rebuilds it |
| `creative/equipment.json` | BDS packets, `CreativeContentPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, block IDs by FNV-1a 32, all resolved: MISMATCH, 367 of our 370 items in our order, the 3 left out ice content, not explained; control differs as pmmp-core rebuilds it |
| `creative/items.json` | BDS packets, `CreativeContentPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, block IDs by FNV-1a 32, all resolved: MISMATCH, 607 of our 729 items in our order, the 122 left out education; control differs as pmmp-core rebuilds it |
| `creative/nature.json` | BDS packets, `CreativeContentPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, block IDs by FNV-1a 32, all resolved: MISMATCH, 439 of our 448 items in our order, the 9 left out ice content, not explained; control differs as pmmp-core rebuilds it |
| `recipes/potion_container_change.json` | BDS packets, `CraftingDataPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, no block IDs: MATCH, 2 entries; control MATCH |
| `recipes/potion_type.json` | BDS packets, `CraftingDataPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, no block IDs, meta by our meta map: MISMATCH, 210 of our 213 in our order, the 3 left out `ice_ball`, not explained; control differs as pmmp-core rebuilds it |
| `recipes/shaped_crafting.json` | BDS packets, `CraftingDataPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, output block IDs by FNV-1a 32, all resolved, input meta by our meta map: MATCH, 1219 entries in order; control differs as pmmp-core rebuilds it |
| `recipes/shaped_crafting_asymmetric.json` | BDS packets, `CraftingDataPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true: MISMATCH, none sent, all 128 of ours education; control sends none |
| `recipes/shapeless_crafting.json` | BDS packets, `CraftingDataPacket` | BDS 1.26.60.6 and 1.26.63.1, NetherNet, hashes true, output block IDs by FNV-1a 32, all resolved, input meta by our meta map: MISMATCH, 2068 of our 2128 in our order, the 60 left out education (`bleach`); control differs as pmmp-core rebuilds it |
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
- **Reversal:** with `canonical_block_states.nbt` from neither source, the steward's
  ruling on #3 brings it back to the steward before the Windows BDS or the #5 route.
