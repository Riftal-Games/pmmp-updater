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
use pocketmine\network\mcpe\protocol\types\inventory\ContainerUIIds;
use pocketmine\network\mcpe\protocol\types\inventory\stackrequest\ItemStackRequestActionType;
use pocketmine\network\mcpe\protocol\types\inventory\WindowTypes;

final class DiscPressConstantsTest extends TestCase{

	/**
	 * @return \Generator<string, array{int, int}>
	 */
	public static function valuesProvider() : \Generator{
		yield "DiscPressBlockContainer" => [67, ContainerUIIds::DISC_PRESS_BLOCK];
		yield "DiscPressDyeContainer" => [68, ContainerUIIds::DISC_PRESS_DYE];
		yield "DiscPressDiscContainer" => [69, ContainerUIIds::DISC_PRESS_DISC];
		yield "DiscPressResultPreviewContainer" => [70, ContainerUIIds::DISC_PRESS_RESULT_PREVIEW];
		yield "RESERVED_CONTAINER_A" => [67, ContainerUIIds::RESERVED_CONTAINER_A];
		yield "RESERVED_CONTAINER_B" => [68, ContainerUIIds::RESERVED_CONTAINER_B];
		yield "RESERVED_CONTAINER_C" => [69, ContainerUIIds::RESERVED_CONTAINER_C];
		yield "RESERVED_CONTAINER_D" => [70, ContainerUIIds::RESERVED_CONTAINER_D];
		yield "DISC_PRESS" => [38, WindowTypes::DISC_PRESS];
		yield "RESERVED_CONTAINER_TYPE" => [38, WindowTypes::RESERVED_CONTAINER_TYPE];
		yield "CraftDiscPress" => [18, ItemStackRequestActionType::INNER_TYPES[ItemStackRequestActionType::CRAFTING_DISC_PRESS]];
		yield "CRAFTING_RESERVED" => [ItemStackRequestActionType::CRAFTING_DISC_PRESS, ItemStackRequestActionType::CRAFTING_RESERVED];
	}

	#[DataProvider('valuesProvider')]
	public function testValue(int $expected, int $actual) : void{
		self::assertSame($expected, $actual);
	}
}
