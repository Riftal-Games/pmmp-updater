<?php

/*
 * This file is part of BedrockProtocol.
 * Copyright (C) 2014-2022 PocketMine Team <https://github.com/pmmp/BedrockProtocol>
 *
 * BedrockProtocol is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

declare(strict_types=1);

namespace pocketmine\network\mcpe\protocol;

use PHPUnit\Framework\TestCase;
use pmmp\encoding\ByteBufferReader;
use pmmp\encoding\ByteBufferWriter;
use pocketmine\math\Vector3;
use pocketmine\network\mcpe\protocol\types\BlockPosition;
use pocketmine\network\mcpe\protocol\types\StructureEditorData;
use pocketmine\network\mcpe\protocol\types\StructureSettings;
use function str_repeat;

final class StructureBlockUpdatePacketTest extends TestCase{

	private static function bytes() : string{
		$position = "\x02\x04\x06";
		$settings = "\x00" . "\x00\x00\x00" . "\x00\x00\x00" . "\x00\x00\x00" . "\x00" . "\x00\x00\x00" . str_repeat("\x00", 4 + 4 + 4 + 12);
		$editorData = "\x01s\x00\x00" . "\x00\x00" . "\x00" . $settings . "\x00";
		return "\x5a" . $position . $editorData . "\x01\x00\x01";
	}

	private static function editorData() : StructureEditorData{
		$settings = new StructureSettings();
		$settings->paletteName = "";
		$settings->ignoreEntities = false;
		$settings->ignoreBlocks = false;
		$settings->allowNonTickingChunks = false;
		$settings->dimensions = new BlockPosition(0, 0, 0);
		$settings->offset = new BlockPosition(0, 0, 0);
		$settings->lastTouchedByPlayerID = 0;
		$settings->rotation = 0;
		$settings->mirror = 0;
		$settings->animationMode = 0;
		$settings->animationSeconds = 0.0;
		$settings->integrityValue = 0.0;
		$settings->integritySeed = 0;
		$settings->pivot = new Vector3(0, 0, 0);

		$data = new StructureEditorData();
		$data->structureName = "s";
		$data->filteredStructureName = null;
		$data->structureDataField = "";
		$data->includePlayers = false;
		$data->showBoundingBox = false;
		$data->structureBlockType = StructureEditorData::TYPE_DATA;
		$data->structureSettings = $settings;
		$data->structureRedstoneSaveMode = 0;
		return $data;
	}

	public function testKeepStructureVoidFollowsIsWaterlogged() : void{
		$out = new ByteBufferWriter();
		StructureBlockUpdatePacket::create(new BlockPosition(1, 2, 3), self::editorData(), true, false, true)->encode($out);
		self::assertSame(self::bytes(), $out->getData());
	}

	public function testDecode() : void{
		$decoded = new StructureBlockUpdatePacket();
		$decoded->decode(new ByteBufferReader(self::bytes()));
		self::assertTrue($decoded->isPowered);
		self::assertFalse($decoded->waterlogged);
		self::assertTrue($decoded->keepStructureVoid);
	}
}
