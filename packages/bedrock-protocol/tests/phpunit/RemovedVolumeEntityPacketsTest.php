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

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use pmmp\encoding\ByteBufferReader;
use pmmp\encoding\ByteBufferWriter;
use pmmp\encoding\VarInt;
use pocketmine\network\mcpe\protocol\serializer\PacketBatch;

/**
 * Mojang's 1.26.70 protocol assigns IDs 166 and 167 to no packet (developer note
 * r26u7/task1692192), so the pool must decode them as unknown.
 */
final class RemovedVolumeEntityPacketsTest extends TestCase{

	/**
	 * @phpstan-return \Generator<string, array{int}, void, void>
	 */
	public static function removedIdsProvider() : \Generator{
		yield "AddVolumeEntityPacket" => [166];
		yield "RemoveVolumeEntityPacket" => [167];
	}

	private static function header(int $id) : string{
		$out = new ByteBufferWriter();
		VarInt::writeUnsignedInt($out, $id);
		return $out->getData();
	}

	#[DataProvider('removedIdsProvider')]
	public function testPoolHasNoPacket(int $id) : void{
		$pool = PacketPool::getInstance();
		self::assertNull($pool->getPacketById($id));
		self::assertNull($pool->getPacket(self::header($id)));
	}

	#[DataProvider('removedIdsProvider')]
	public function testBatchDecodeFails(int $id) : void{
		$out = new ByteBufferWriter();
		PacketBatch::encodeRaw($out, [self::header($id)]);

		$this->expectException(PacketDecodeException::class);
		$this->expectExceptionMessage("Unknown packet 0 in batch");
		foreach(PacketBatch::decodePackets(new ByteBufferReader($out->getData()), PacketPool::getInstance()) as $packet){
			self::fail("ID $id decoded as " . $packet->getName());
		}
	}

	public function testNeighboursStillRegistered() : void{
		$pool = PacketPool::getInstance();
		self::assertInstanceOf(SyncActorPropertyPacket::class, $pool->getPacketById(165));
		self::assertInstanceOf(SimulationTypePacket::class, $pool->getPacketById(168));
	}
}
