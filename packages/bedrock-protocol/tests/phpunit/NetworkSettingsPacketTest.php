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

use PHPUnit\Framework\Attributes\TestWith;
use PHPUnit\Framework\TestCase;
use pmmp\encoding\ByteBufferReader;
use pmmp\encoding\ByteBufferWriter;
use pocketmine\network\mcpe\protocol\types\CompressionAlgorithm;
use pocketmine\network\mcpe\protocol\types\SctpRecoveryProfile;
use function array_column;

final class NetworkSettingsPacketTest extends TestCase{

	private const HEAD = "\x8f\x01\x01\x00\x00\x00\x01\x02\x00\x00\x80\x3f";

	public function testSctpRecoveryProfileIsAByteAfterTheThrottleScalar() : void{
		$out = new ByteBufferWriter();
		NetworkSettingsPacket::create(NetworkSettingsPacket::COMPRESS_EVERYTHING, CompressionAlgorithm::ZLIB, true, 2, 1.0, SctpRecoveryProfile::BALANCED)->encode($out);
		self::assertSame(self::HEAD . "\x02", $out->getData());
	}

	#[TestWith(["\x00", SctpRecoveryProfile::DEFAULT])]
	#[TestWith(["\x01", SctpRecoveryProfile::FAST])]
	#[TestWith(["\x02", SctpRecoveryProfile::BALANCED])]
	public function testDecode(string $profileByte, SctpRecoveryProfile $profile) : void{
		$decoded = new NetworkSettingsPacket();
		$decoded->decode(new ByteBufferReader(self::HEAD . $profileByte));
		self::assertSame($profile, $decoded->getSctpRecoveryProfile());
		self::assertSame(1.0, $decoded->getClientThrottleScalar());
	}

	public function testDecodeRejectsUnknownProfile() : void{
		$this->expectException(PacketDecodeException::class);
		$this->expectExceptionMessage("Invalid raw value 3 for " . SctpRecoveryProfile::class);
		(new NetworkSettingsPacket())->decode(new ByteBufferReader(self::HEAD . "\x03"));
	}

	public function testDecodeRejectsMissingProfile() : void{
		$this->expectException(PacketDecodeException::class);
		(new NetworkSettingsPacket())->decode(new ByteBufferReader(self::HEAD));
	}

	public function testEnumValues() : void{
		self::assertSame(["DEFAULT" => 0, "FAST" => 1, "BALANCED" => 2], array_column(SctpRecoveryProfile::cases(), "value", "name"));
	}
}
