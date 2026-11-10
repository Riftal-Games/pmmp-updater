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
use pocketmine\network\mcpe\protocol\types\ManagedChatJoinInfo;
use pocketmine\network\mcpe\protocol\types\PresenceInfo;
use pocketmine\network\mcpe\protocol\types\ServerJoinInformation;

final class ServerJoinInformationTest extends TestCase{

	private const BYTES = "\x00\x00\x01\x01\x01p\x01\x01";

	public function testManagedChatIsAPresencePrefixedBlockAfterPresence() : void{
		$out = new ByteBufferWriter();
		(new ServerJoinInformation(null, null, new PresenceInfo("p"), new ManagedChatJoinInfo(true)))->write($out);
		self::assertSame(self::BYTES, $out->getData());
	}

	public function testEnabledIsAPlainBool() : void{
		$out = new ByteBufferWriter();
		(new ServerJoinInformation(null, null, null, new ManagedChatJoinInfo(false)))->write($out);
		self::assertSame("\x00\x00\x00\x01\x00", $out->getData());
	}

	public function testManagedChatAbsent() : void{
		$out = new ByteBufferWriter();
		(new ServerJoinInformation(null, null, null))->write($out);
		self::assertSame("\x00\x00\x00\x00", $out->getData());
	}

	public function testDecode() : void{
		$decoded = ServerJoinInformation::read(new ByteBufferReader(self::BYTES));
		self::assertSame("p", $decoded->getPresenceInfo()?->getRichPresenceId());
		self::assertTrue($decoded->getManagedChatJoinInfo()?->isEnabled());
	}
}
