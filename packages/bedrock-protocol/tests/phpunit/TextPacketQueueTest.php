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

final class TextPacketQueueTest extends TestCase{

	private const QUEUED_JUKEBOX_POPUP = "\x09\x01\x02\x04\x01k\x01\x01p\x01\x00\x00\x00";

	private static function encode(TextPacket $packet) : string{
		$out = new ByteBufferWriter();
		$packet->encode($out);
		return $out->getData();
	}

	public function testQueueFollowsParameterList() : void{
		$packet = TextPacket::jukeboxPopup("k", ["p"]);
		$packet->queue = true;
		self::assertSame(self::QUEUED_JUKEBOX_POPUP, self::encode($packet));
	}

	public function testQueueDefaultsToFalse() : void{
		self::assertSame("\x09\x01\x02\x02\x01k\x00\x00\x00\x00\x00", self::encode(TextPacket::translation("k")));
	}

	public function testMessageOnlyCarriesNoQueue() : void{
		self::assertSame("\x09\x00\x00\x00\x01m\x00\x00\x00", self::encode(TextPacket::raw("m")));
	}

	public function testDecode() : void{
		$decoded = new TextPacket();
		$decoded->decode(new ByteBufferReader(self::QUEUED_JUKEBOX_POPUP));
		self::assertSame(TextPacket::TYPE_JUKEBOX_POPUP, $decoded->type);
		self::assertSame(["p"], $decoded->parameters);
		self::assertTrue($decoded->queue);
		self::assertSame("", $decoded->xboxUserId);
		self::assertNull($decoded->filteredMessage);
	}
}
