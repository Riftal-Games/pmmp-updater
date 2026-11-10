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
use pmmp\encoding\VarInt;
use pocketmine\network\mcpe\protocol\PacketDecodeException;
use pocketmine\network\mcpe\protocol\serializer\CommonTypes;
use pocketmine\network\mcpe\protocol\types\ddui\update\BoolDataStoreUpdateValue;
use pocketmine\network\mcpe\protocol\types\ddui\update\DataStoreUpdateValue;
use pocketmine\network\mcpe\protocol\types\ddui\update\DataStoreUpdateValueType;
use pocketmine\network\mcpe\protocol\types\ddui\update\DoubleDataStoreUpdateValue;
use pocketmine\network\mcpe\protocol\types\ddui\update\StringDataStoreUpdateValue;
use pocketmine\network\mcpe\protocol\types\GetTypeIdFromConstTrait;

/**
 * @see ServerboundDataStorePacket
 * @see ClientboundDataStorePacket
 */
final class DataStoreUpdate implements DataStoreOperation{
	use GetTypeIdFromConstTrait;

	public const ID = DataStoreOperationType::UPDATE;

	public function __construct(
		private string $variableName,
		private DataStoreUpdateValue $data,
		private int $updateCount,
	){}

	public function getVariableName() : string{ return $this->variableName; }

	public function getData() : DataStoreUpdateValue{ return $this->data; }

	public function getUpdateCount() : int{ return $this->updateCount; }

	/**
	 * The variable value union, shared with {@see DataStoreChange}.
	 */
	public static function readValue(ByteBufferReader $in) : DataStoreUpdateValue{
		return match(VarInt::readUnsignedInt($in)){
			DataStoreUpdateValueType::DOUBLE => DoubleDataStoreUpdateValue::read($in),
			DataStoreUpdateValueType::BOOL => BoolDataStoreUpdateValue::read($in),
			DataStoreUpdateValueType::STRING => StringDataStoreUpdateValue::read($in),
			default => throw new PacketDecodeException("Unknown DataStoreValueType"),
		};
	}

	public static function writeValue(ByteBufferWriter $out, DataStoreUpdateValue $value) : void{
		VarInt::writeUnsignedInt($out, $value->getTypeId());
		$value->write($out);
	}

	public static function read(ByteBufferReader $in) : self{
		$variableName = CommonTypes::getString($in);
		$data = self::readValue($in);
		$updateCount = LE::readUnsignedInt($in);

		return new self(
			$variableName,
			$data,
			$updateCount,
		);
	}

	public function write(ByteBufferWriter $out) : void{
		CommonTypes::putString($out, $this->variableName);
		self::writeValue($out, $this->data);
		LE::writeUnsignedInt($out, $this->updateCount);
	}
}
