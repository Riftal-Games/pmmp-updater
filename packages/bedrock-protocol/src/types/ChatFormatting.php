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

namespace pocketmine\network\mcpe\protocol\types;

use pmmp\encoding\ByteBufferReader;
use pmmp\encoding\ByteBufferWriter;
use pocketmine\network\mcpe\protocol\serializer\CommonTypes;

final class ChatFormatting{

	public function __construct(
		private readonly ?string $namePrefix,
		private readonly ?string $namePostfix,
		private readonly ?string $messagePrefix,
		private readonly ?string $messagePostfix
	){
	}

	public function getNamePrefix() : ?string{
		return $this->namePrefix;
	}

	public function getNamePostfix() : ?string{
		return $this->namePostfix;
	}

	public function getMessagePrefix() : ?string{
		return $this->messagePrefix;
	}

	public function getMessagePostfix() : ?string{
		return $this->messagePostfix;
	}

	public static function read(ByteBufferReader $in) : self{
		$namePrefix = CommonTypes::readOptional($in, CommonTypes::getString(...));
		$namePostfix = CommonTypes::readOptional($in, CommonTypes::getString(...));
		$messagePrefix = CommonTypes::readOptional($in, CommonTypes::getString(...));
		$messagePostfix = CommonTypes::readOptional($in, CommonTypes::getString(...));

		return new self($namePrefix, $namePostfix, $messagePrefix, $messagePostfix);
	}

	public function write(ByteBufferWriter $out) : void{
		CommonTypes::writeOptional($out, $this->namePrefix, CommonTypes::putString(...));
		CommonTypes::writeOptional($out, $this->namePostfix, CommonTypes::putString(...));
		CommonTypes::writeOptional($out, $this->messagePrefix, CommonTypes::putString(...));
		CommonTypes::writeOptional($out, $this->messagePostfix, CommonTypes::putString(...));
	}
}
