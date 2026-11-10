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
use pocketmine\network\mcpe\protocol\types\command\CommandOriginData;
use pocketmine\network\mcpe\protocol\types\command\CommandOutputMessage;
use Ramsey\Uuid\Uuid;
use function str_repeat;

final class CommandOutputPacketTest extends TestCase{

	private static function bytes() : string{
		$origin = "\x06player" . str_repeat("\x00", 16) . "\x00" . str_repeat("\x00", 8);
		$raw = "\x01m\x01\x01\x01p\x01\x01r";
		$plain = "\x01n\x00\x00\x00";
		return "\x4f" . $origin . "\x09alloutput\x02\x00\x00\x00\x02" . $raw . $plain . "\x00";
	}

	/**
	 * @param string[] $parameters
	 */
	private static function message(string $id, bool $internal, array $parameters, ?string $rawMessage) : CommandOutputMessage{
		$message = new CommandOutputMessage();
		$message->messageId = $id;
		$message->isInternal = $internal;
		$message->parameters = $parameters;
		$message->rawMessage = $rawMessage;
		return $message;
	}

	public function testRawMessageIsAPresencePrefixedStringAfterParameters() : void{
		$origin = new CommandOriginData();
		$origin->type = CommandOriginData::ORIGIN_PLAYER;
		$origin->uuid = Uuid::fromString(Uuid::NIL);
		$origin->requestId = "";
		$origin->playerActorUniqueId = 0;

		$packet = new CommandOutputPacket();
		$packet->originData = $origin;
		$packet->outputType = CommandOutputPacket::TYPE_ALL;
		$packet->successCount = 2;
		$packet->messages = [self::message("m", true, ["p"], "r"), self::message("n", false, [], null)];
		$packet->data = null;

		$out = new ByteBufferWriter();
		$packet->encode($out);
		self::assertSame(self::bytes(), $out->getData());
	}

	public function testDecode() : void{
		$decoded = new CommandOutputPacket();
		$decoded->decode(new ByteBufferReader(self::bytes()));
		self::assertCount(2, $decoded->messages);
		self::assertSame(["p"], $decoded->messages[0]->parameters);
		self::assertSame("r", $decoded->messages[0]->rawMessage);
		self::assertNull($decoded->messages[1]->rawMessage);
	}
}
