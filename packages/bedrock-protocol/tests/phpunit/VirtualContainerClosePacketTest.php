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
use pocketmine\network\mcpe\protocol\types\inventory\VirtualContainerCloseCause;
use pocketmine\network\mcpe\protocol\types\inventory\VirtualContainerCloseKind;
use function array_column;

final class VirtualContainerClosePacketTest extends TestCase{

	private const SESSION_ID = 1 << 35;
	private const BYTES = "\xef\x02\x80\x80\x80\x80\x80\x01\x01\x07";

	public function testFieldsAreWrittenInOrdinalOrder() : void{
		$out = new ByteBufferWriter();
		VirtualContainerClosePacket::create(self::SESSION_ID, VirtualContainerCloseKind::CLOSED, VirtualContainerCloseCause::UI_CANCELLED)->encode($out);
		self::assertSame(self::BYTES, $out->getData());
	}

	public function testDecode() : void{
		$decoded = PacketPool::getInstance()->getPacketById(367);
		self::assertInstanceOf(VirtualContainerClosePacket::class, $decoded);
		$decoded->decode(new ByteBufferReader(self::BYTES));
		self::assertSame(self::SESSION_ID, $decoded->getSessionId());
		self::assertSame(VirtualContainerCloseKind::CLOSED, $decoded->getKind());
		self::assertSame(VirtualContainerCloseCause::UI_CANCELLED, $decoded->getCause());
	}

	#[TestWith(["\x03\x00", "3 for " . VirtualContainerCloseKind::class])]
	#[TestWith(["\x00\x08", "8 for " . VirtualContainerCloseCause::class])]
	public function testDecodeRejectsUnknownValue(string $kindAndCause, string $message) : void{
		$this->expectException(PacketDecodeException::class);
		$this->expectExceptionMessage("Invalid raw value " . $message);
		(new VirtualContainerClosePacket())->decode(new ByteBufferReader("\xef\x02\x01" . $kindAndCause));
	}

	public function testEnumValues() : void{
		self::assertSame(["REQUEST" => 0, "CLOSED" => 1, "CONFIRMED" => 2], array_column(VirtualContainerCloseKind::cases(), "value", "name"));
		self::assertSame([
			"UNKNOWN" => 0, "USER_CLOSED" => 1, "SERVER_REQUESTED" => 2, "USER_BUSY" => 3,
			"CLIENT_NOT_READY" => 4, "INVALID_CONTENTS" => 5, "UI_CREATION_FAILED" => 6, "UI_CANCELLED" => 7,
		], array_column(VirtualContainerCloseCause::cases(), "value", "name"));
	}
}
