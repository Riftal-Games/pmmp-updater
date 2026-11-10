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
use pocketmine\network\mcpe\protocol\types\ddui\DataStoreChange;
use pocketmine\network\mcpe\protocol\types\ddui\DataStoreRemoval;
use pocketmine\network\mcpe\protocol\types\ddui\DataStoreUpdate;
use pocketmine\network\mcpe\protocol\types\ddui\update\BoolDataStoreUpdateValue;
use pocketmine\network\mcpe\protocol\types\ddui\update\DoubleDataStoreUpdateValue;
use pocketmine\network\mcpe\protocol\types\ddui\update\StringDataStoreUpdateValue;

final class DataStorePacketTest extends TestCase{

	private const CLIENTBOUND = "\xca\x02\x04"
		. "\x00\x01a\x00\x00\x00\x00\x00\x00\x00\xf0\x3f\x02\x00\x00\x00"
		. "\x01\x01b\x03\x00\x00\x00\x01\x01"
		. "\x01\x01c\x04\x00\x00\x00\x02\x01x"
		. "\x02\x01d";

	private const SERVERBOUND = "\xcc\x02\x01v\x02\x01s\x07\x00\x00\x00";

	private static function encode(DataPacket $packet) : string{
		$out = new ByteBufferWriter();
		$packet->encode($out);
		return $out->getData();
	}

	public function testClientboundEncode() : void{
		$packet = ClientboundDataStorePacket::create([
			new DataStoreUpdate("a", new DoubleDataStoreUpdateValue(1.0), 2),
			new DataStoreChange("b", 3, new BoolDataStoreUpdateValue(true)),
			new DataStoreChange("c", 4, new StringDataStoreUpdateValue("x")),
			new DataStoreRemoval("d"),
		]);
		self::assertSame(self::CLIENTBOUND, self::encode($packet));
	}

	public function testClientboundDecode() : void{
		$decoded = new ClientboundDataStorePacket();
		$decoded->decode(new ByteBufferReader(self::CLIENTBOUND));
		self::assertCount(4, $decoded->values);
		[$update, $boolChange, $stringChange, $removal] = $decoded->values;

		self::assertInstanceOf(DataStoreUpdate::class, $update);
		self::assertSame("a", $update->getVariableName());
		$data = $update->getData();
		self::assertInstanceOf(DoubleDataStoreUpdateValue::class, $data);
		self::assertSame(1.0, $data->getValue());
		self::assertSame(2, $update->getUpdateCount());

		self::assertInstanceOf(DataStoreChange::class, $boolChange);
		self::assertSame("b", $boolChange->getVariableName());
		self::assertSame(3, $boolChange->getUpdateCount());
		$value = $boolChange->getValue();
		self::assertInstanceOf(BoolDataStoreUpdateValue::class, $value);
		self::assertTrue($value->getValue());

		self::assertInstanceOf(DataStoreChange::class, $stringChange);
		$value = $stringChange->getValue();
		self::assertInstanceOf(StringDataStoreUpdateValue::class, $value);
		self::assertSame("x", $value->getValue());

		self::assertInstanceOf(DataStoreRemoval::class, $removal);
		self::assertSame("d", $removal->getVariableName());
	}

	public function testServerboundRoundTrip() : void{
		$packet = ServerboundDataStorePacket::create(new DataStoreUpdate("v", new StringDataStoreUpdateValue("s"), 7));
		self::assertSame(self::SERVERBOUND, self::encode($packet));

		$decoded = new ServerboundDataStorePacket();
		$decoded->decode(new ByteBufferReader(self::SERVERBOUND));
		self::assertSame("v", $decoded->getUpdate()->getVariableName());
		self::assertSame(7, $decoded->getUpdate()->getUpdateCount());
	}

	public function testChangeRejectsUnknownValueType() : void{
		$decoded = new ClientboundDataStorePacket();
		$this->expectException(PacketDecodeException::class);
		$decoded->decode(new ByteBufferReader("\xca\x02\x01\x01\x01b\x03\x00\x00\x00\x03"));
	}
}
