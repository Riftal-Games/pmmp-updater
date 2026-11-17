<?php

declare(strict_types=1);

// Encodes a capture of invented blocks, items and biomes with packages/bedrock-protocol,
// runs decode.php on it in a separate PHP process, and checks the dump it prints. Then
// checks that decode.php stops, never falls through, when a protocol class is missing from
// the package it is given, and on a capture it cannot account for byte by byte.
// Usage: php decode.test.php <autoload.php>, an autoloader for the package's dependencies:
// its own composer install, or the PocketMine-MP phar's vendor/autoload.php.

use pmmp\encoding\ByteBufferWriter;
use pocketmine\color\Color;
use pocketmine\math\Vector3;
use pocketmine\nbt\TreeRoot;
use pocketmine\nbt\tag\{CompoundTag, ListTag};
use pocketmine\network\mcpe\protocol as P;
use pocketmine\network\mcpe\protocol\serializer\NetworkNbtSerializer;
use pocketmine\network\mcpe\protocol\types as T;
use pocketmine\network\mcpe\protocol\types\biome\BiomeDefinitionEntry;
use pocketmine\network\mcpe\protocol\types\inventory\{CreativeGroupEntry, CreativeItemEntry, ItemStack, ItemStackExtraData};
use pocketmine\network\mcpe\protocol\types\recipe as R;
use Ramsey\Uuid\Uuid;

$autoload = $argv[1] ?? throw new InvalidArgumentException('usage: php decode.test.php <autoload.php>');
$protocol = dirname(__DIR__, 3) . '/packages/bedrock-protocol';
require $autoload;
// Ahead of any protocol library the autoloader knows, so the capture is encoded by ours.
spl_autoload_register(function(string $class) use ($protocol) : void{
	$prefix = 'pocketmine\\network\\mcpe\\protocol\\';
	if(str_starts_with($class, $prefix)){
		require "$protocol/src/" . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
	}
}, true, true);

$failed = 0;
$check = function(bool $ok, string $what, string $detail) use (&$failed) : void{
	echo $ok ? "ok - $what\n" : "not ok - $what: $detail\n";
	$failed += $ok ? 0 : 1;
};
$bytes = function(callable $write) : string{
	$w = new ByteBufferWriter();
	$write($w);
	return $w->getData();
};
$record = fn(P\Packet $pk, string $extra = '') => pack('nN', $pk->pid(), strlen($raw = $bytes($pk->encode(...)) . $extra)) . $raw;
$tmp = sys_get_temp_dir() . '/bds-decode-test-' . getmypid();
mkdir($tmp);
$decode = function(string $capture, string $dir) use ($autoload, $tmp) : array{
	file_put_contents("$tmp/capture.bin", $capture);
	$p = proc_open([PHP_BINARY, '-d', 'display_errors=stderr', dirname(__DIR__) . '/decode.php', $autoload, $dir, "$tmp/capture.bin"], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
	[$out, $err] = [stream_get_contents($pipes[1]), stream_get_contents($pipes[2])];
	return [proc_close($p), $out, $err];
};

$level = new T\LevelSettings();
[$level->seed, $level->spawnSettings, $level->worldGamemode, $level->difficulty, $level->spawnPosition, $level->rainLevel, $level->lightningLevel, $level->commandsEnabled] =
	[0, new T\SpawnSettings(0, '', 0), T\GameMode::SURVIVAL, 0, new T\BlockPosition(0, 0, 0), 0.0, 0.0, false];
[$level->hasEduFeaturesEnabled, $level->experiments] = [true, new T\Experiments(['fixture_toggle' => true], false)];
$glow = CompoundTag::create()->setByte('fixture_lit', 1);
$start = P\StartGamePacket::create(
	1, 1, T\GameMode::SURVIVAL, new Vector3(0, 0, 0), 0.0, 0.0, new T\CacheableNbt(CompoundTag::create()), $level, '', '', '', false,
	new T\PlayerMovementSettings(0, false), 0, 0, '', false, '', Uuid::fromString(Uuid::NIL), false, true, new T\NetworkPermissions(false), null,
	new T\ServerTelemetryData('', '', '', ''), [new T\BlockPaletteEntry('fixture:glow', new T\CacheableNbt($glow))], 0
);
$items = P\ItemRegistryPacket::create([
	new T\ItemTypeEntry('fixture:lamp', -1, false, 2, new T\CacheableNbt(CompoundTag::create())),
	new T\ItemTypeEntry('fixture:dust', 5, true, 1, new T\CacheableNbt(CompoundTag::create()->setString('fixture_key', 'v'))),
]);
$extra = $bytes((new ItemStackExtraData(CompoundTag::create()->setInt('fixture_tag', 1), ['fixture:slab'], ['fixture:lamp']))->write(...));
$creative = P\CreativeContentPacket::create(
	[new CreativeGroupEntry(1, 'fixture_group', new ItemStack(-1, 0, 1, 7, ''))],
	[new CreativeItemEntry(1, new ItemStack(5, 3, 2, 0, $extra), 0)]
);
// One recipe in every list the generator reads, with each kind of ingredient and an empty slot.
$id = fn(string $name, int $meta) => new R\RecipeIngredient(new R\StringIdMetaItemDescriptor($name, $meta), 1);
[$tag, $molang, $nil] = [new R\RecipeIngredient(new R\TagItemDescriptor('fixture:tag'), 2), new R\RecipeIngredient(new R\MolangItemDescriptor('q.fixture', 9), 1), Uuid::fromString(Uuid::NIL)];
$unlock = new R\RecipeUnlockingRequirement(R\RecipeUnlockingContext::NONE, [$id('fixture:dust', 32767)]);
$shaped = fn(bool $symmetric) => new R\ShapedRecipe('fixture_shaped', [[$id('fixture:lamp', 1), new R\RecipeIngredient(null, 0)]], [new ItemStack(-1, 0, 1, 8, '')], $nil, 'fixture_table', 2, $symmetric, $unlock, 2);
$recipe = fn(array $outputs) => new R\ShapelessRecipe('fixture_recipe', [$tag, $molang], $outputs, $nil, 'fixture_table', 0, null, 1);
$crafting = P\CraftingDataPacket::create(
	[$shaped(true)], [$recipe([new ItemStack(-1, 0, 1, 8, '')])], [new R\MultiRecipe(Uuid::fromString('00000000-0000-0000-0000-000000000001'), 3)], [$recipe([])], [$recipe([new ItemStack(5, 0, 4, 0, ''), ItemStack::null()])], [$shaped(false)],
	[new R\SmithingTransformRecipe('fixture_smith', $id('fixture:dust', 0), $id('fixture:lamp', 1), $tag, new ItemStack(5, 0, 1, 0, ''), 'fixture_smithy', 4)],
	[new R\SmithingTrimRecipe('fixture_trim', $tag, $molang, $id('fixture:dust', 0), 'fixture_smithy', 5)],
	[new R\PotionTypeRecipe(5, 1, -1, 0, 5, 2)], [new R\PotionContainerChangeRecipe(5, -1, 99)], [], true
);
$biomes = P\BiomeDefinitionListPacket::fromDefinitions([new BiomeDefinitionEntry('fixture:plains', 1, 0.123, 0.5, 0.25, 0.1, 0.2, new Color(1, 2, 3, 4), true, ['fixture_warm'])]);
$mobs = CompoundTag::create()->setTag('idlist', new ListTag([CompoundTag::create()->setString('id', 'fixture:mob')]));
$pools = CompoundTag::create()->setString('fixture_pool', 'fixture:start');
$jigsaw = P\JigsawStructureDataPacket::create(new T\CacheableNbt($pools));
$shapes = P\VoxelShapesPacket::create([new T\SerializableVoxelShape(new T\SerializableVoxelCells(1, 1, 2, [1, 0]), [0.0, 1.0], [0.0, 0.5], [0.0, 1.0])], ['fixture:box' => 0], 0);
// Packet ID 1000, its varint header alone, names no packet of ours.
$unknown = pack('nN', 1000, 2) . "\xe8\x07";
$capture = implode('', [$record($start), $record($items), $record($creative), $record($crafting), $record($biomes), $record(P\AvailableActorIdentifiersPacket::create(new T\CacheableNbt($mobs))), $unknown, $record($jigsaw), $record($shapes)]);

$network = fn(CompoundTag $t) => hash('sha256', (new NetworkNbtSerializer())->write(new TreeRoot($t)));
$stack = fn(string $name, int $meta, int $count, int $block, ?string $nbt = null, array $on = [], array $off = []) => ['name' => $name, 'meta' => $meta, 'count' => $count, 'block' => $block, 'nbt' => $nbt, 'can_place_on' => $on, 'can_destroy' => $off];
$in = fn(?string $name, int $meta) => ['id' => $name, 'meta' => $meta, 'count' => 1];
[$tagIn, $molangIn] = [['tag' => 'fixture:tag', 'count' => 2], ['molang_expression' => 'q.fixture', 'molang_version' => 9, 'count' => 1]];
$shapedOut = fn(bool $symmetric) => ['input' => [[$in('fixture:lamp', 1), null]], 'output' => [$stack('fixture:lamp', 0, 1, 8)], 'block' => 'fixture_table', 'priority' => 2, 'symmetric' => $symmetric, 'unlocking' => [$in('fixture:dust', 32767)]];
$recipeOut = fn(array $outputs) => ['input' => [$tagIn, $molangIn], 'output' => $outputs, 'block' => 'fixture_table', 'priority' => 0, 'unlocking' => null];
$want = [
	'protocol' => P\ProtocolInfo::CURRENT_PROTOCOL, 'version' => P\ProtocolInfo::MINECRAFT_VERSION_NETWORK, 'records' => 9, 'unknown' => [1000],
	'start_game' => ['hashes' => true, 'experiments' => ['fixture_toggle' => true], 'education' => true, 'data_driven_blocks' => $network(CompoundTag::create()->setTag('blockPalette', new ListTag([CompoundTag::create()->setString('name', 'fixture:glow')->setTag('states', $glow)])))],
	'items' => [
		['name' => 'fixture:lamp', 'runtime_id' => -1, 'component_based' => false, 'version' => 2, 'component_nbt' => null],
		['name' => 'fixture:dust', 'runtime_id' => 5, 'component_based' => true, 'version' => 1, 'component_nbt' => base64_encode("\x0a\x00\x00\x08\x0b\x00fixture_key\x01\x00v\x00")],
	],
	'creative' => [
		'groups' => [['category' => 1, 'name' => 'fixture_group', 'icon' => $stack('fixture:lamp', 0, 1, 7)]],
		'items' => [['group' => 0, 'item' => $stack('fixture:dust', 3, 2, 0, base64_encode("\x0a\x00\x00\x03\x0b\x00fixture_tag\x01\x00\x00\x00\x00"), ['fixture:slab'], ['fixture:lamp'])]],
	],
	'crafting' => [
		'shaped_crafting' => [$shapedOut(true)], 'shaped_chemistry' => [$shapedOut(false)],
		'shapeless_crafting' => [$recipeOut([$stack('fixture:lamp', 0, 1, 8)])], 'shapeless_shulker_box' => [$recipeOut([])], 'shapeless_chemistry' => [$recipeOut([$stack('fixture:dust', 0, 4, 0), null])],
		'special_hardcoded' => ['00000000-0000-0000-0000-000000000001'],
		'smithing' => [['template' => $in('fixture:dust', 0), 'input' => $in('fixture:lamp', 1), 'addition' => $tagIn, 'block' => 'fixture_smithy', 'output' => $stack('fixture:dust', 0, 1, 0)]],
		'smithing_trim' => [['template' => $tagIn, 'input' => $molangIn, 'addition' => $in('fixture:dust', 0), 'block' => 'fixture_smithy']],
		'potion_type' => [['input' => $in('fixture:dust', 1), 'ingredient' => $in('fixture:lamp', 0), 'output' => $stack('fixture:dust', 2, 1, 0)]],
		'potion_container_change' => [['input' => 'fixture:dust', 'ingredient' => $in('fixture:lamp', 0), 'output' => null]],
	],
	'biomes' => ['fixture:plains' => ['id' => 1, 'temperature' => 0.123, 'downfall' => 0.5, 'foliageSnow' => 0.25, 'depth' => 0.1, 'scale' => 0.2, 'rain' => true, 'tags' => ['fixture_warm'], 'mapWaterColour' => ['r' => 1, 'g' => 2, 'b' => 3, 'a' => 4]]],
	'actors' => $network($mobs),
	'jigsaw' => $network($pools),
	'voxel_shapes' => ['custom' => 0, 'nameMap' => ['fixture:box' => 0], 'shapes' => [['cells' => ['storage' => [1, 0], 'xSize' => 1, 'ySize' => 1, 'zSize' => 2], 'x' => [0.0, 1.0], 'y' => [0.0, 0.5], 'z' => [0.0, 1.0]]]],
];

[$status, $out, $err] = $decode($capture, $protocol);
$check($status === 0, 'decode.php exits 0 on the synthetic capture', $err);
$got = json_decode($out, true) ?? [];
$check(array_keys($got) === array_keys($want), 'the dump has exactly the sections it should', implode(', ', array_keys($got)));
foreach($want as $key => $value){
	$check(($got[$key] ?? null) === $value, "the dump's $key", json_encode($got[$key] ?? null));
}

// A copy of the package with one packet class left out. The autoloader named first knows
// that class from elsewhere, so only the prepended loader that throws stops the decode.
foreach(new RecursiveIteratorIterator(new RecursiveDirectoryIterator("$protocol/src", FilesystemIterator::SKIP_DOTS)) as $f){
	$to = "$tmp/without/src/" . substr($f->getPathname(), strlen("$protocol/src/"));
	is_dir(dirname($to)) or mkdir(dirname($to), 0777, true);
	basename($to) === 'VoxelShapesPacket.php' or copy($f->getPathname(), $to);
}
[$status, , $err] = $decode($capture, "$tmp/without");
$check($status !== 0 && str_contains($err, "LogicException: pocketmine\\network\\mcpe\\protocol\\VoxelShapesPacket is not in $tmp/without"), 'a class missing from the package throws', "exit $status, $err");

// Block updates, alone and as a sub-chunk's on both layers, are each kept in the order sent,
// however often the same one comes.
$update = P\UpdateBlockPacket::create(new T\BlockPosition(1, -2, 3), 23959, P\UpdateBlockPacket::FLAG_NETWORK, P\UpdateBlockPacket::DATA_LAYER_NORMAL);
$entry = fn(int $id) => new T\UpdateSubChunkBlocksPacketEntry(new T\BlockPosition(-4, 5, 6), $id, 3, 0, 0);
$updates = $record($update) . $record(P\UpdateSubChunkBlocksPacket::create(new T\BlockPosition(-16, 0, 0), [$entry(7)], [$entry(8)])) . $record($update);
[$status, $out, $err] = $decode($updates, $protocol);
$check($status === 0 && (json_decode($out, true)['block_updates'] ?? null) === [[1, -2, 3, 23959, 2, 0], [-4, 5, 6, 7, 3, 0], [-4, 5, 6, 8, 3, 1], [1, -2, 3, 23959, 2, 0]], 'block updates are kept in order with their layer', "exit $status, $out, $err");

foreach([
	'runs past the end of the capture' => substr($capture, 0, -1),
	'the capture holds JigsawStructureDataPacket twice' => $capture . $record($jigsaw),
	'JigsawStructureDataPacket decodes 33 of its 34 bytes' => $record($jigsaw, "\x00"),
	'UpdateBlockPacket decodes 9 of its 10 bytes' => $record($update, "\x00"),
	'UpdateSubChunkBlocksPacket decodes 14 of its 15 bytes' => $record(P\UpdateSubChunkBlocksPacket::create(new T\BlockPosition(0, 0, 0), [$entry(7)], []), "\x00"),
] as $message => $bad){
	[$status, , $err] = $decode($bad, $protocol);
	$check($status !== 0 && str_contains($err, $message), "a capture it cannot account for stops it: $message", "exit $status, $err");
}

foreach(new RecursiveIteratorIterator(new RecursiveDirectoryIterator($tmp, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST) as $f){
	$f->isDir() ? rmdir($f->getPathname()) : unlink($f->getPathname());
}
rmdir($tmp);
echo $failed === 0 ? "all passed\n" : "$failed failed\n";
exit($failed === 0 ? 0 : 1);
