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

namespace pocketmine\network\mcpe\protocol\types\ddui;

use pmmp\encoding\ByteBufferReader;
use pmmp\encoding\ByteBufferWriter;
use pmmp\encoding\LE;
use pocketmine\network\mcpe\protocol\serializer\CommonTypes;
use pocketmine\network\mcpe\protocol\types\ddui\update\DataStoreUpdateValue;
use pocketmine\network\mcpe\protocol\types\GetTypeIdFromConstTrait;

/**
 * @see ClientboundDataStorePacket
 */
final class DataStoreChange implements DataStoreOperation{
	use GetTypeIdFromConstTrait;

	public const ID = DataStoreOperationType::CHANGE;

	public function __construct(
		private string $variableName,
		private int $updateCount,
		private DataStoreUpdateValue $value
	){}

	public function getVariableName() : string{ return $this->variableName; }

	public function getUpdateCount() : int{ return $this->updateCount; }

	public function getValue() : DataStoreUpdateValue{ return $this->value; }

	public static function read(ByteBufferReader $in) : self{
		$variableName = CommonTypes::getString($in);
		$updateCount = LE::readUnsignedInt($in);
		$value = DataStoreUpdate::readValue($in);

		return new self(
			$variableName,
			$updateCount,
			$value,
		);
	}

	public function write(ByteBufferWriter $out) : void{
		CommonTypes::putString($out, $this->variableName);
		LE::writeUnsignedInt($out, $this->updateCount);
		DataStoreUpdate::writeValue($out, $this->value);
	}
}
