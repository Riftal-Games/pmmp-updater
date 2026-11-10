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
use pocketmine\network\mcpe\protocol\types\inventory\stackrequest\CraftReservedStackRequestAction;
use pocketmine\network\mcpe\protocol\types\inventory\stackrequest\ItemStackRequest;
use pocketmine\network\mcpe\protocol\types\inventory\stackrequest\ItemStackRequestActionType;

final class ItemStackRequestPacketTest extends TestCase{

	private const BYTES = "\x93\x01\x01\x0a\x01\x10\x12\x0drecord.flurry\x02\x00\x00\x00\x00\x00";

	public function testDiscPressSendsTrackThenCraftCount() : void{
		$action = new CraftReservedStackRequestAction("record.flurry", 2);
		$out = new ByteBufferWriter();
		ItemStackRequestPacket::create([new ItemStackRequest(5, [$action], [], 0)])->encode($out);
		self::assertSame(self::BYTES, $out->getData());
	}

	public function testDecode() : void{
		$decoded = new ItemStackRequestPacket();
		$decoded->decode(new ByteBufferReader(self::BYTES));
		$action = $decoded->getRequests()[0]->getActions()[0];
		self::assertInstanceOf(CraftReservedStackRequestAction::class, $action);
		self::assertSame(ItemStackRequestActionType::CRAFTING_DISC_PRESS, $action->getTypeId());
		self::assertSame("record.flurry", $action->getTrackSoundEventId());
		self::assertSame(2, $action->getNumCrafts());
	}
}
