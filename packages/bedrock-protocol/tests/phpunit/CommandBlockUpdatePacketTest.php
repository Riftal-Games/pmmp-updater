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

final class CommandBlockUpdatePacketTest extends TestCase{

	private const BYTES = "\x4e\x00\x05\x01c\x01o\x01n\x01f\x01\x03\x00\x00\x00\x01\x00";

	public function testLastOutputIsRawMessageFollowsExecuteOnFirstTick() : void{
		$packet = new CommandBlockUpdatePacket();
		$packet->isBlock = false;
		$packet->minecartActorRuntimeId = 5;
		$packet->command = "c";
		$packet->lastOutput = "o";
		$packet->name = "n";
		$packet->filteredName = "f";
		$packet->shouldTrackOutput = true;
		$packet->tickDelay = 3;
		$packet->executeOnFirstTick = true;
		$packet->lastOutputIsRawMessage = false;

		$out = new ByteBufferWriter();
		$packet->encode($out);
		self::assertSame(self::BYTES, $out->getData());
	}

	public function testDecode() : void{
		$decoded = new CommandBlockUpdatePacket();
		$decoded->decode(new ByteBufferReader(self::BYTES));
		self::assertTrue($decoded->executeOnFirstTick);
		self::assertFalse($decoded->lastOutputIsRawMessage);
	}
}
