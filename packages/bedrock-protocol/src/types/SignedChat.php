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

final class SignedChat{

	public function __construct(
		private readonly string $keyId,
		private readonly string $senderId,
		private readonly string $messageId,
		private readonly string $scanText,
		private readonly string $redactedText,
		private readonly string $authorName,
		private readonly string $signature
	){
	}

	public function getKeyId() : string{
		return $this->keyId;
	}

	public function getSenderId() : string{
		return $this->senderId;
	}

	public function getMessageId() : string{
		return $this->messageId;
	}

	public function getScanText() : string{
		return $this->scanText;
	}

	public function getRedactedText() : string{
		return $this->redactedText;
	}

	public function getAuthorName() : string{
		return $this->authorName;
	}

	public function getSignature() : string{
		return $this->signature;
	}

	public static function read(ByteBufferReader $in) : self{
		$keyId = CommonTypes::getString($in);
		$senderId = CommonTypes::getString($in);
		$messageId = CommonTypes::getString($in);
		$scanText = CommonTypes::getString($in);
		$redactedText = CommonTypes::getString($in);
		$authorName = CommonTypes::getString($in);
		$signature = CommonTypes::getString($in);

		return new self($keyId, $senderId, $messageId, $scanText, $redactedText, $authorName, $signature);
	}

	public function write(ByteBufferWriter $out) : void{
		CommonTypes::putString($out, $this->keyId);
		CommonTypes::putString($out, $this->senderId);
		CommonTypes::putString($out, $this->messageId);
		CommonTypes::putString($out, $this->scanText);
		CommonTypes::putString($out, $this->redactedText);
		CommonTypes::putString($out, $this->authorName);
		CommonTypes::putString($out, $this->signature);
	}
}
