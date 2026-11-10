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
use function chr;
use function str_repeat;

final class ListDecodeBoundsTest extends TestCase{

	private const DIAGNOSTICS_HEAD = "\xbb\x02";
	private const MEMORY_CATEGORY_COUNTER = "\x00\x00\x00\x00\x00\x00\x00\x00\x00";
	private const WHISKER_SCOPE = "\x00\x00" . "\x00\x00\x00\x00\x00\x00\x00\x00" . "\x00\x00\x00\x00\x00\x00\x00\x00" . "\x00\x00\x00\x00\x00\x00\x00\x00";

	private static function emoteList(int $count) : string{
		return "\x98\x01\x01" . chr($count) . str_repeat("\x00", 16 * $count);
	}

	private static function playerFog(int $count) : string{
		return "\xa0\x01" . chr($count) . str_repeat("\x00", $count);
	}

	private static function diagnostics(int $memoryCategories, int $whiskerScopes) : string{
		return self::DIAGNOSTICS_HEAD . str_repeat("\x00", 36)
			. chr($memoryCategories) . str_repeat(self::MEMORY_CATEGORY_COUNTER, $memoryCategories)
			. "\x00\x00\x00"
			. chr($whiskerScopes) . str_repeat(self::WHISKER_SCOPE, $whiskerScopes);
	}

	/**
	 * Each update is a removal of the empty variable name: type 2, then an empty string.
	 */
	private static function dataStoreRemovals(string $countVarInt, int $count) : string{
		return "\xca\x02" . $countVarInt . str_repeat("\x02\x00", $count);
	}

	public function testEmoteListAcceptsSix() : void{
		$decoded = new EmoteListPacket();
		$decoded->decode(new ByteBufferReader(self::emoteList(6)));
		self::assertCount(6, $decoded->getEmoteIds());
	}

	public function testEmoteListRejectsSeven() : void{
		$this->expectException(PacketDecodeException::class);
		$this->expectExceptionMessage("Expected at most 6 emote IDs, got 7");
		(new EmoteListPacket())->decode(new ByteBufferReader(self::emoteList(7)));
	}

	public function testPlayerFogAcceptsSixteen() : void{
		$decoded = new PlayerFogPacket();
		$decoded->decode(new ByteBufferReader(self::playerFog(16)));
		self::assertCount(16, $decoded->getFogLayers());
	}

	public function testPlayerFogRejectsSeventeen() : void{
		$this->expectException(PacketDecodeException::class);
		$this->expectExceptionMessage("Expected at most 16 fog layers, got 17");
		(new PlayerFogPacket())->decode(new ByteBufferReader(self::playerFog(17)));
	}

	public function testDiagnosticsAcceptsBothBounds() : void{
		$decoded = new ServerboundDiagnosticsPacket();
		$decoded->decode(new ByteBufferReader(self::diagnostics(111, 33)));
		self::assertCount(111, $decoded->getMemoryCategoryValues());
		self::assertCount(33, $decoded->getWhiskerScopes());
	}

	public function testDiagnosticsRejectsMemoryCategoryValuesOverBound() : void{
		$this->expectException(PacketDecodeException::class);
		$this->expectExceptionMessage("Expected at most 111 memory category values, got 112");
		(new ServerboundDiagnosticsPacket())->decode(new ByteBufferReader(self::diagnostics(112, 0)));
	}

	public function testDiagnosticsRejectsWhiskerScopesOverBound() : void{
		$this->expectException(PacketDecodeException::class);
		$this->expectExceptionMessage("Expected at most 33 whisker scopes, got 34");
		(new ServerboundDiagnosticsPacket())->decode(new ByteBufferReader(self::diagnostics(0, 34)));
	}

	public function testDataStoreAcceptsFiveHundred() : void{
		$decoded = new ClientboundDataStorePacket();
		$decoded->decode(new ByteBufferReader(self::dataStoreRemovals("\xf4\x03", 500)));
		self::assertCount(500, $decoded->values);
	}

	public function testDataStoreRejectsFiveHundredAndOne() : void{
		$this->expectException(PacketDecodeException::class);
		$this->expectExceptionMessage("Expected at most 500 updates, got 501");
		(new ClientboundDataStorePacket())->decode(new ByteBufferReader(self::dataStoreRemovals("\xf5\x03", 501)));
	}
}
