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

final class PlayerToggleArmorVisibilityRequestPacketTest extends TestCase{

	public function testRoundTrip() : void{
		$out = new ByteBufferWriter();
		PlayerToggleArmorVisibilityRequestPacket::create(true)->encode($out);
		self::assertSame("\xec\x02\x01", $out->getData());

		$decoded = new PlayerToggleArmorVisibilityRequestPacket();
		$decoded->decode(new ByteBufferReader($out->getData()));
		self::assertTrue($decoded->getHideArmor());
	}
}
