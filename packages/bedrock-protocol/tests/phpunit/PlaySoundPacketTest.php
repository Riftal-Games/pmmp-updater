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
use pocketmine\network\mcpe\protocol\types\sound\AudioContentPlaybackType;

final class PlaySoundPacketTest extends TestCase{

	private const PAYLOAD_HEAD = "\x01s\x00\x00\x00\x00\x00\x80\x3f\x00\x00\x80\x3f\x00\x00\x00";
	private const BYTES = "\x56" . self::PAYLOAD_HEAD . "\x01\x00\x00\x80\x3e\x01\x00\x00\x00\x3f";

	private static function packet(?float $playbackPositionSeconds, ?float $startDelaySeconds) : PlaySoundPacket{
		return PlaySoundPacket::create("s", 0, 0, 0, 1, 1, 0, false, null, $playbackPositionSeconds, $startDelaySeconds);
	}

	private static function encode(DataPacket $packet) : string{
		$out = new ByteBufferWriter();
		$packet->encode($out);
		return $out->getData();
	}

	public function testStartDelayFollowsPlaybackPosition() : void{
		self::assertSame(self::BYTES, self::encode(self::packet(0.25, 0.5)));
	}

	public function testZeroStartDelayIsPresent() : void{
		self::assertSame("\x56" . self::PAYLOAD_HEAD . "\x00\x01\x00\x00\x00\x00", self::encode(self::packet(null, 0.0)));
	}

	public function testStartDelayAbsent() : void{
		self::assertSame("\x56" . self::PAYLOAD_HEAD . "\x00\x00", self::encode(self::packet(null, null)));
	}

	public function testDecode() : void{
		$decoded = new PlaySoundPacket();
		$decoded->decode(new ByteBufferReader(self::BYTES));
		self::assertSame(0.25, $decoded->playbackPositionSeconds);
		self::assertSame(0.5, $decoded->startDelaySeconds);
	}

	public function testAudioContentConcurrentMusicByte() : void{
		$bytes = "\xe7\x02\x01m\x01c\x02" . self::PAYLOAD_HEAD . "\x00\x01\x00\x00\x00\x3f";
		$packet = ClientboundPlayAudioContentPacket::create("m", "c", AudioContentPlaybackType::CONCURRENT_MUSIC, self::packet(null, 0.5));
		self::assertSame($bytes, self::encode($packet));

		$decoded = new ClientboundPlayAudioContentPacket();
		$decoded->decode(new ByteBufferReader($bytes));
		self::assertSame(AudioContentPlaybackType::CONCURRENT_MUSIC, $decoded->getPlaybackType());
		self::assertSame(0.5, $decoded->getPlaySound()->startDelaySeconds);
	}
}
