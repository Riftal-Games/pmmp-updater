<?php

declare(strict_types=1);

// Decodes the packets ADR 002 sources BedrockData files from, out of a capture.bin
// tracer.js wrote, with the bedrock-protocol package at <protocol dir>, and prints them as
// JSON for decode.js. Packet IDs and layouts come from that package alone. The autoloader
// named first supplies only what does not change per version: nbt, binaryutils, math, color
// and uuid, from the PocketMine-MP phar or the package's own composer install. ext-encoding
// comes from the PHP it runs on.
// Usage: php decode.php <autoload.php> <protocol dir> <capture.bin>

use pmmp\encoding\ByteBufferReader;
use pocketmine\nbt\{LittleEndianNbtSerializer, TreeRoot};
use pocketmine\nbt\tag\{CompoundTag, ListTag};
use pocketmine\network\mcpe\protocol as P;
use pocketmine\network\mcpe\protocol\serializer\NetworkNbtSerializer;
use pocketmine\network\mcpe\protocol\types\inventory\{ItemStack, ItemStackExtraData, ItemStackExtraDataShield};

count($argv) === 4 or throw new InvalidArgumentException('usage: php decode.php <autoload.php> <protocol dir> <capture.bin>');
[, $autoload, $protocol, $capture] = $argv;
require $autoload;

// Prepended, and failing rather than falling through, so no protocol class of another
// library the autoloader knows is ever loaded in place of ours.
spl_autoload_register(function(string $class) use ($protocol) : void{
	$prefix = 'pocketmine\\network\\mcpe\\protocol\\';
	if(str_starts_with($class, $prefix)){
		$file = "$protocol/src/" . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
		require is_file($file) ? $file : throw new LogicException("$class is not in $protocol");
	}
}, true, true);

$le = fn(CompoundTag $t) : ?string => $t->count() === 0 ? null : base64_encode((new LittleEndianNbtSerializer())->write(new TreeRoot($t)));
$sha = fn(string $bytes) : string => hash('sha256', $bytes);
$names = [];
$stack = function(ItemStack $s) use (&$names, $le) : ?array{
	if($s->getId() === 0){
		return null;
	}
	$out = ['name' => $names[$s->getId()] ?? null, 'meta' => $s->getMeta(), 'count' => $s->getCount(), 'block' => $s->getBlockRuntimeId(), 'nbt' => null, 'can_place_on' => [], 'can_destroy' => []];
	if($s->getRawExtraData() !== ''){
		$in = new ByteBufferReader($s->getRawExtraData());
		$x = $out['name'] === 'minecraft:shield' ? ItemStackExtraDataShield::read($in) : ItemStackExtraData::read($in);
		[$out['nbt'], $out['can_place_on'], $out['can_destroy']] = [$x->getNbt() === null ? null : $le($x->getNbt()), $x->getCanPlaceOn(), $x->getCanDestroy()];
	}
	return $out;
};
$keys = [
	P\StartGamePacket::class => 'start_game', P\ItemRegistryPacket::class => 'items', P\CreativeContentPacket::class => 'creative', P\CraftingDataPacket::class => 'crafting',
	P\BiomeDefinitionListPacket::class => 'biomes', P\AvailableActorIdentifiersPacket::class => 'actors', P\JigsawStructureDataPacket::class => 'jigsaw', P\VoxelShapesPacket::class => 'voxel_shapes',
];

$data = file_get_contents($capture);
$out = ['protocol' => P\ProtocolInfo::CURRENT_PROTOCOL, 'version' => P\ProtocolInfo::MINECRAFT_VERSION_NETWORK, 'records' => 0, 'unknown' => []];
for($at = 0; $at < strlen($data); $at += 6 + $len){
	['id' => $id, 'len' => $len] = unpack('nid/Nlen', $data, $at);
	$raw = substr($data, $at + 6, $len);
	strlen($raw) === $len or throw new RuntimeException("the record at byte $at runs past the end of the capture");
	$out['records']++;
	$pk = P\PacketPool::getInstance()->getPacket($raw);
	if($pk === null || $pk->pid() !== $id){
		$out['unknown'][] = $id;
		continue;
	}
	if(($key = $keys[$pk::class] ?? null) === null){
		continue;
	}
	isset($out[$key]) and throw new RuntimeException("the capture holds {$pk->getName()} twice");
	$pk->decode($in = new ByteBufferReader($raw));
	$in->getOffset() === $len or throw new RuntimeException("{$pk->getName()} decodes {$in->getOffset()} of its $len bytes");
	$out[$key] = match($key){
		'start_game' => [
			'hashes' => $pk->blockNetworkIdsAreHashes, 'experiments' => $pk->levelSettings->experiments->getExperiments(), 'education' => $pk->levelSettings->hasEduFeaturesEnabled,
			'data_driven_blocks' => $sha((new NetworkNbtSerializer())->write(new TreeRoot(CompoundTag::create()->setTag('blockPalette', new ListTag(array_map(
				fn($e) => CompoundTag::create()->setString('name', $e->getName())->setTag('states', $e->getStates()->getRoot()),
				$pk->blockPalette
			)))))),
		],
		'items' => array_map(function($e) use (&$names, $le){
			$names[$e->getNumericId()] = $e->getStringId();
			return ['name' => $e->getStringId(), 'runtime_id' => $e->getNumericId(), 'component_based' => $e->isComponentBased(), 'version' => $e->getVersion(), 'component_nbt' => $le($e->getComponentNbt()->getRoot())];
		}, $pk->getEntries()),
		'creative' => [
			'groups' => array_map(fn($g) => ['category' => $g->getCategoryId(), 'name' => $g->getCategoryName(), 'icon' => $stack($g->getIcon())], $pk->getGroups()),
			'items' => array_map(fn($i) => ['group' => $i->getGroupId(), 'item' => $stack($i->getItem())], $pk->getItems()),
		],
		// Only the outputs carry block network IDs.
		'crafting' => ['outputs' => array_map($stack, array_merge(
			...array_map(fn($r) => $r->getOutput(), [...$pk->shapedRecipes, ...$pk->shapedChemistryRecipes]),
			...array_map(fn($r) => $r->getOutputs(), [...$pk->shapelessRecipes, ...$pk->userDataShapelessRecipes, ...$pk->shapelessChemistryRecipes]),
			...[array_map(fn($r) => $r->getOutput(), $pk->smithingTransformRecipes)],
		))],
		// Rounded as BedrockData stores them.
		'biomes' => array_combine(array_map(fn($b) => $b->getBiomeName(), $defs = $pk->buildDefinitionsFromData()), array_map(fn($b) => [
			'id' => $b->getId(), 'temperature' => round($b->getTemperature(), 3), 'downfall' => round($b->getDownfall(), 3), 'foliageSnow' => round($b->getFoliageSnow(), 3),
			'depth' => round($b->getDepth(), 3), 'scale' => round($b->getScale(), 3), 'rain' => $b->hasRain(), 'tags' => $b->getTags() ?? [],
			'mapWaterColour' => ['r' => $b->getMapWaterColor()->getR(), 'g' => $b->getMapWaterColor()->getG(), 'b' => $b->getMapWaterColor()->getB(), 'a' => $b->getMapWaterColor()->getA()],
		], $defs)),
		'actors' => $sha($pk->identifiers->getEncodedNbt()),
		'jigsaw' => $sha($pk->getNbt()->getEncodedNbt()),
		'voxel_shapes' => ['custom' => $pk->getCustomShapeCount(), 'nameMap' => $pk->getNameMap(), 'shapes' => array_map(fn($s) => [
			'cells' => ['storage' => $s->getCells()->getStorage(), 'xSize' => $s->getCells()->getXSize(), 'ySize' => $s->getCells()->getYSize(), 'zSize' => $s->getCells()->getZSize()],
			'x' => $s->getXCoordinates(), 'y' => $s->getYCoordinates(), 'z' => $s->getZCoordinates(),
		], $pk->getShapes())],
	};
}
echo json_encode($out, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION), "\n";
