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

final class ServerboundRequestOnlineMusicPlaybackPacketTest extends TestCase{

	private const BYTES = "\xea\x02\x04\x03\x02\x01\x0drecord.flurry";

	public function testFieldsAreWrittenInOrdinalOrder() : void{
		$out = new ByteBufferWriter();
		ServerboundRequestOnlineMusicPlaybackPacket::create(0x01020304, "record.flurry")->encode($out);
		self::assertSame(self::BYTES, $out->getData());
	}

	public function testDecode() : void{
		$decoded = new ServerboundRequestOnlineMusicPlaybackPacket();
		$decoded->decode(new ByteBufferReader(self::BYTES));
		self::assertSame(0x01020304, $decoded->getRequestId());
		self::assertSame("record.flurry", $decoded->getSoundEventName());
	}
}
