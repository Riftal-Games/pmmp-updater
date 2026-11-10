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
use pocketmine\network\mcpe\protocol\types\InputMode;
use pocketmine\network\mcpe\protocol\types\LevelSoundEvent;
use pocketmine\network\mcpe\protocol\types\PlayerAction;
use pocketmine\network\mcpe\protocol\types\PlayerAuthInputFlags;
use pocketmine\network\mcpe\protocol\types\sound\AudioContentPlaybackType;
use function defined;

final class InputAndSoundValuesTest extends TestCase{

	/**
	 * @return \Generator<string, array{mixed, mixed}>
	 */
	public static function valuesProvider() : \Generator{
		yield "GamePadAndMouse" => [InputMode::GAME_PAD_AND_MOUSE, InputMode::fromPacket(5)];
		yield "MOTION_CONTROLLER" => [InputMode::MOTION_CONTROLLER, InputMode::fromPacket(4)];
		yield "ConcurrentMusic" => [AudioContentPlaybackType::CONCURRENT_MUSIC, AudioContentPlaybackType::fromPacket(2)];
		yield "SwapOffhand input" => [65, PlayerAuthInputFlags::SWAP_OFFHAND];
		yield "INTERNAL_UPDATE" => [65, PlayerAuthInputFlags::INTERNAL_UPDATE];
		yield "NUMBER_OF_FLAGS" => [66, PlayerAuthInputFlags::NUMBER_OF_FLAGS];
		yield "SwapOffhand action" => [38, PlayerAction::SWAP_OFFHAND];
		yield "convert_to_frostbite" => ["convert_to_frostbite", LevelSoundEvent::CONVERT_TO_FROSTBITE];
		yield "convert_to_zombie" => ["convert_to_zombie", LevelSoundEvent::CONVERT_TO_ZOMBIE];
		yield "crack" => ["crack", LevelSoundEvent::CRACK];
		yield "ice_ball.throw" => ["ice_ball.throw", LevelSoundEvent::ICE_BALL_THROW];
		yield "record.flurry" => ["record.flurry", LevelSoundEvent::RECORD_FLURRY];
		yield "imitate.frostbite" => ["imitate.frostbite", LevelSoundEvent::IMITATE_FROSTBITE];
	}

	#[DataProvider('valuesProvider')]
	public function testValue(mixed $expected, mixed $actual) : void{
		self::assertSame($expected, $actual);
	}

	public function testIceBallBreakIsGone() : void{
		self::assertFalse(defined(LevelSoundEvent::class . "::ICE_BALL_BREAK"));
	}
}
