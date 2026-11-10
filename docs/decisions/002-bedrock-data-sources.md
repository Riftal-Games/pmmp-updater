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

## Decision

| File | Source | Measured |
|---|---|---|
| `canonical_block_states.nbt` | neither: samples MISMATCH, missing 14 blocks with no stated reason and giving no state order; packets carry only the data-driven blocks and a checksum (ADR 001). Back to the steward before #5 | samples, above |
| `required_item_list.json` | BDS packets, `ItemRegistryPacket`; samples MISMATCH, a subset whose 1627 IDs agree | samples, above; packets PR 3 |
| `data_driven_blocks.nbt` | BDS packets, `StartGamePacket` | PR 3 |
| `creative/construction.json` | BDS packets, `CreativeContentPacket` | PR 3 |
| `creative/equipment.json` | BDS packets, `CreativeContentPacket` | PR 3 |
| `creative/items.json` | BDS packets, `CreativeContentPacket` | PR 3 |
| `creative/nature.json` | BDS packets, `CreativeContentPacket` | PR 3 |
| `recipes/potion_container_change.json` | BDS packets, `CraftingDataPacket` | PR 3 |
| `recipes/potion_type.json` | BDS packets, `CraftingDataPacket` | PR 3 |
| `recipes/shaped_crafting.json` | BDS packets, `CraftingDataPacket` | PR 3 |
| `recipes/shaped_crafting_asymmetric.json` | BDS packets, `CraftingDataPacket` | PR 3 |
| `recipes/shapeless_crafting.json` | BDS packets, `CraftingDataPacket` | PR 3 |
| `recipes/shapeless_shulker_box.json` | BDS packets, `CraftingDataPacket` | PR 3 |
| `recipes/smithing.json` | BDS packets, `CraftingDataPacket` | PR 3 |
| `recipes/smithing_trim.json` | BDS packets, `CraftingDataPacket` | PR 3 |
| `recipes/special_hardcoded.json` | BDS packets, `CraftingDataPacket` | PR 3 |
| `biome_definitions.json` | BDS packets, `BiomeDefinitionListPacket` | PR 3 |
| `entity_identifiers.nbt` | BDS packets, `AvailableActorIdentifiersPacket` | PR 3 |
| `jigsaw_structures_data.nbt` | BDS packets, `JigsawStructureDataPacket` | PR 3 |
| `voxel_shapes.json` | BDS packets, `VoxelShapesPacket` | PR 3 |
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
