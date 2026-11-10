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
use pocketmine\network\mcpe\protocol\types\Experiments;
use pocketmine\network\mcpe\protocol\types\resourcepacks\EditorPackType;
use function chr;

final class ResourcePackStackPacketTest extends TestCase{

	private static function bytes(int $editorPackTypes) : string{
		return "\x07\x01\x00\x071.26.70\x00\x00\x00\x00\x00" . chr($editorPackTypes);
	}

	public function testEditorPackTypesIsAByteAfterExperiments() : void{
		$out = new ByteBufferWriter();
		ResourcePackStackPacket::create([], true, "1.26.70", new Experiments([], false), EditorPackType::CORE | EditorPackType::ANNOTATION)->encode($out);
		self::assertSame(self::bytes(3), $out->getData());
	}

	public function testDecodeKeepsEveryBit() : void{
		foreach([EditorPackType::NONE, EditorPackType::ANNOTATION, EditorPackType::CORE | EditorPackType::ANNOTATION, 0xff] as $editorPackTypes){
			$decoded = new ResourcePackStackPacket();
			$decoded->decode(new ByteBufferReader(self::bytes($editorPackTypes)));
			self::assertTrue($decoded->mustAccept);
			self::assertSame("1.26.70", $decoded->baseGameVersion);
			self::assertSame($editorPackTypes, $decoded->editorPackTypes);
		}
	}
}
