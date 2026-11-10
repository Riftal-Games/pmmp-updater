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
use pocketmine\network\mcpe\protocol\types\ChatFormatting;
use pocketmine\network\mcpe\protocol\types\SignedChat;

final class ChatPacketTest extends TestCase{

	private const SIGNED_BYTES = "\x01k\x01s\x01m\x04scan\x03red\x06author\x03sig";

	private static function signedChat() : SignedChat{
		return new SignedChat("k", "s", "m", "scan", "red", "author", "sig");
	}

	private static function encode(ChatPacket $packet) : string{
		$out = new ByteBufferWriter();
		$packet->encode($out);
		return $out->getData();
	}

	public function testSignedChatIsWrittenInOrdinalOrder() : void{
		self::assertSame("\xe9\x02" . self::SIGNED_BYTES . "\x00\x00", self::encode(ChatPacket::create(self::signedChat(), null, null)));
	}

	public function testFormattingFieldsAreEachPresencePrefixed() : void{
		$packet = ChatPacket::create(self::signedChat(), null, new ChatFormatting("<", null, "[", "]"));
		self::assertSame("\xe9\x02" . self::SIGNED_BYTES . "\x00\x01\x01\x01<\x00\x01\x01[\x01\x01]", self::encode($packet));
	}

	public function testRoomIdIsPresencePrefixedBetweenSignedChatAndFormatting() : void{
		$packet = ChatPacket::create(self::signedChat(), "room", new ChatFormatting(null, null, null, null));
		self::assertSame("\xe9\x02" . self::SIGNED_BYTES . "\x01\x04room\x01\x00\x00\x00\x00", self::encode($packet));
	}

	public function testDecodeWithoutRoomId() : void{
		$decoded = new ChatPacket();
		$decoded->decode(new ByteBufferReader("\xe9\x02" . self::SIGNED_BYTES . "\x00\x00"));
		self::assertNull($decoded->getRoomId());
		self::assertSame("author", $decoded->getSignedChat()->getAuthorName());
		self::assertNull($decoded->getFormatting());
	}

	public function testRoundTrip() : void{
		$decoded = new ChatPacket();
		$decoded->decode(new ByteBufferReader(self::encode(ChatPacket::create(self::signedChat(), "room", new ChatFormatting("<", null, "[", "]")))));

		$signed = $decoded->getSignedChat();
		self::assertSame(
			["k", "s", "m", "scan", "red", "author", "sig"],
			[$signed->getKeyId(), $signed->getSenderId(), $signed->getMessageId(), $signed->getScanText(), $signed->getRedactedText(), $signed->getAuthorName(), $signed->getSignature()]
		);
		self::assertSame("room", $decoded->getRoomId());
		$formatting = $decoded->getFormatting();
		self::assertNotNull($formatting);
		self::assertSame(
			["<", null, "[", "]"],
			[$formatting->getNamePrefix(), $formatting->getNamePostfix(), $formatting->getMessagePrefix(), $formatting->getMessagePostfix()]
		);
	}
}
