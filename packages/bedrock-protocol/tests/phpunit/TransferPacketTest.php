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
use pocketmine\network\mcpe\protocol\types\TransferPlayerUIOptions;

final class TransferPacketTest extends TestCase{

	private const HEAD = "\x55\x01h\xbc\x4a\x00\x00";
	private const WITH_SETTINGS = self::HEAD . "\x01"
		. "\x01\x01T" . "\x00" . "\x01\x01" . "\x00" . "\x01\x01C" . "\x01\x00" . "\x01\x00\x00\x20\x40";

	private static function encode(TransferPacket $packet) : string{
		$out = new ByteBufferWriter();
		$packet->encode($out);
		return $out->getData();
	}

	public function testSettingsFollowGatheringsConfiguration() : void{
		$settings = new TransferPlayerUIOptions("T", null, true, null, "C", false, 2.5);
		self::assertSame(self::WITH_SETTINGS, self::encode(TransferPacket::create("h", 19132, false, null, $settings)));
	}

	public function testSettingsAbsent() : void{
		self::assertSame(self::HEAD . "\x00", self::encode(TransferPacket::create("h", 19132, false, null, null)));
	}

	public function testDecode() : void{
		$decoded = new TransferPacket();
		$decoded->decode(new ByteBufferReader(self::WITH_SETTINGS));
		$settings = $decoded->serverTransferSettings;
		self::assertNotNull($settings);
		self::assertSame("T", $settings->getTitleText());
		self::assertNull($settings->getBodyText());
		self::assertTrue($settings->getTitleVisible());
		self::assertNull($settings->getBodyVisible());
		self::assertSame("C", $settings->getCancelButtonText());
		self::assertFalse($settings->getCancelButtonVisible());
		self::assertSame(2.5, $settings->getCancelButtonDelaySeconds());
	}
}
