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
use pocketmine\network\mcpe\protocol\types\EmoteType;
use pocketmine\network\mcpe\protocol\types\PassengerOfBlockData;

final class PassengerOfBlockDataTest extends TestCase{

	private const BYTES = "\xe5\x02\x02\x01"
		. "\x00\x00\x00"
		. "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
		. "\x00\x00\xb4\x42\x00\x00\x34\x42"
		. "\x01"
		. "\x08\x07\x06\x05\x04\x03\x02\x01";

	public function testBlockTypeIsAFixedWidthLongAfterEmoteType() : void{
		$data = new PassengerOfBlockData(new BlockPosition(0, 0, 0), new Vector3(0, 0, 0), 90.0, 45.0, EmoteType::RIDING, 0x0102030405060708);
		$out = new ByteBufferWriter();
		SetPassengerOfBlockPacket::create(1, $data)->encode($out);
		self::assertSame(self::BYTES, $out->getData());
	}

	public function testDecode() : void{
		$decoded = new SetPassengerOfBlockPacket();
		$decoded->decode(new ByteBufferReader(self::BYTES));
		self::assertSame(EmoteType::RIDING, $decoded->getPassengerData()?->getEmoteType());
		self::assertSame(0x0102030405060708, $decoded->getPassengerData()?->getBlockType());
	}
}
