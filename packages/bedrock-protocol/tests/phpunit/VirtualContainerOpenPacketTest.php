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
use pocketmine\network\mcpe\protocol\types\inventory\ContainerUIIds;
use pocketmine\network\mcpe\protocol\types\inventory\ItemStack;
use pocketmine\network\mcpe\protocol\types\inventory\ItemStackWrapper;
use pocketmine\network\mcpe\protocol\types\inventory\WindowTypes;
use function chr;
use function str_repeat;

final class VirtualContainerOpenPacketTest extends TestCase{

	private const SESSION_ID = 1 << 35;
	private const EMPTY_SLOT = "\x00\x00\x00\x00\x00\x00\x00\x00";
	private const BYTES = "\xee\x02\xc8\x80\x80\x80\x80\x80\x01\x05Chest\x02" . self::EMPTY_SLOT . "\x05\x00\x03\x00\x02\x01\x12\x07\x00";

	/**
	 * @return ItemStackWrapper[]
	 */
	private static function slots() : array{
		return [
			new ItemStackWrapper(0, ItemStack::null()),
			new ItemStackWrapper(9, new ItemStack(5, 2, 3, 7, "")),
		];
	}

	private static function withSlotCount(int $count) : string{
		return "\xee\x02\x00\x01\x00" . chr($count) . str_repeat(self::EMPTY_SLOT, $count);
	}

	public function testFieldsAreWrittenInOrdinalOrder() : void{
		$out = new ByteBufferWriter();
		VirtualContainerOpenPacket::create(200, self::SESSION_ID, "Chest", self::slots())->encode($out);
		self::assertSame(self::BYTES, $out->getData());
	}

	public function testDecode() : void{
		$decoded = PacketPool::getInstance()->getPacketById(366);
		self::assertInstanceOf(VirtualContainerOpenPacket::class, $decoded);
		$decoded->decode(new ByteBufferReader(self::BYTES));
		self::assertSame(200, $decoded->getContainerId());
		self::assertSame(self::SESSION_ID, $decoded->getSessionId());
		self::assertSame("Chest", $decoded->getTitle());
		self::assertEquals(self::slots(), $decoded->getSlots());
	}

	#[TestWith([1])]
	#[TestWith([54])]
	public function testDecodeAcceptsSlotCount(int $count) : void{
		$decoded = new VirtualContainerOpenPacket();
		$decoded->decode(new ByteBufferReader(self::withSlotCount($count)));
		self::assertCount($count, $decoded->getSlots());
	}

	#[TestWith([0])]
	#[TestWith([55])]
	public function testDecodeRejectsSlotCount(int $count) : void{
		$this->expectException(PacketDecodeException::class);
		$this->expectExceptionMessage("Expected between 1 and 54 slots, got $count");
		(new VirtualContainerOpenPacket())->decode(new ByteBufferReader(self::withSlotCount($count)));
	}

	public function testDecodeLeavesSessionIdAndTitleLengthUnchecked() : void{
		$decoded = new VirtualContainerOpenPacket();
		$decoded->decode(new ByteBufferReader("\xee\x02\x00\x00\x81\x02" . str_repeat("a", 257) . "\x01" . self::EMPTY_SLOT));
		self::assertSame(0, $decoded->getSessionId());
		self::assertSame(str_repeat("a", 257), $decoded->getTitle());
	}

	#[TestWith([39, WindowTypes::VIRTUAL_CONTAINER])]
	#[TestWith([71, ContainerUIIds::VIRTUAL_CONTAINER])]
	public function testContainerConstant(int $expected, int $actual) : void{
		self::assertSame($expected, $actual);
	}
}
