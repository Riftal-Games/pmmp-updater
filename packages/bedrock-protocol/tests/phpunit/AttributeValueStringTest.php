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
use pocketmine\network\mcpe\protocol\types\AttributeEnvironmentConstant;
use pocketmine\network\mcpe\protocol\types\AttributeValue;
use pocketmine\network\mcpe\protocol\types\AttributeValueString;

final class AttributeValueStringTest extends TestCase{

	private const BYTES = "\x03\x01v\x08override";

	public function testValueThenOperationAfterVariantThree() : void{
		$out = new ByteBufferWriter();
		(new AttributeEnvironmentConstant(new AttributeValueString("v", AttributeValueString::OPERATION_OVERRIDE)))->write($out);
		self::assertSame(self::BYTES, $out->getData());
	}

	public function testDecode() : void{
		$decoded = AttributeValue::read(new ByteBufferReader(self::BYTES));
		self::assertInstanceOf(AttributeValueString::class, $decoded);
		self::assertSame("v", $decoded->getValue());
		self::assertSame("override", $decoded->getOperation());
	}
}
