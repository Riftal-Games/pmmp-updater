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
use pocketmine\network\mcpe\protocol\types\inventory\ContainerUIIds;
use pocketmine\network\mcpe\protocol\types\inventory\FullContainerName;
use function str_repeat;

final class ContainerRegistryCleanupPacketTest extends TestCase{

	private const BYTES = "\xbd\x02\x02\x43\x00\x3f\x01\x07\x00\x00\x00";

	public function testEncode() : void{
		$out = new ByteBufferWriter();
		ContainerRegistryCleanupPacket::create([
			new FullContainerName(ContainerUIIds::DISC_PRESS_BLOCK),
			new FullContainerName(ContainerUIIds::DYNAMIC, 7),
		])->encode($out);
		self::assertSame(self::BYTES, $out->getData());
	}

	public function testDecodeAcceptsOneThousand() : void{
		$decoded = new ContainerRegistryCleanupPacket();
		$decoded->decode(new ByteBufferReader("\xbd\x02\xe8\x07" . str_repeat("\x00\x00", 1000)));
		self::assertCount(1000, $decoded->getRemovedContainers());
	}

	public function testDecodeRejectsMoreThanOneThousand() : void{
		$decoded = new ContainerRegistryCleanupPacket();
		$this->expectException(PacketDecodeException::class);
		$this->expectExceptionMessage("Expected at most 1000 removed containers, got 1001");
		$decoded->decode(new ByteBufferReader("\xbd\x02\xe9\x07" . str_repeat("\x00\x00", 1001)));
	}
}
