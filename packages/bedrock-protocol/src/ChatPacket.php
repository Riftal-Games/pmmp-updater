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

use pmmp\encoding\ByteBufferReader;
use pmmp\encoding\ByteBufferWriter;
use pocketmine\network\mcpe\protocol\serializer\CommonTypes;
use pocketmine\network\mcpe\protocol\types\ChatFormatting;
use pocketmine\network\mcpe\protocol\types\SignedChat;

/**
 * The Signed Chat block carries a Chat Service signature that receiving clients verify, so a server relays it
 * byte for byte. Room Id and Formatting are outside the signature, so a server may reroute through the one and
 * decorate through the other.
 */
final class ChatPacket extends DataPacket implements ClientboundPacket, ServerboundPacket{

	public const NETWORK_ID = ProtocolInfo::CHAT_PACKET;

	private SignedChat $signedChat;

	/** Null for the default chat. */
	private ?string $roomId;

	private ?ChatFormatting $formatting;

	/**
	 * @generate-create-func
	 */
	public static function create(SignedChat $signedChat, ?string $roomId, ?ChatFormatting $formatting) : self{
		$result = new self;
		$result->signedChat = $signedChat;
		$result->roomId = $roomId;
		$result->formatting = $formatting;
		return $result;
	}

	public function getSignedChat() : SignedChat{
		return $this->signedChat;
	}

	public function getRoomId() : ?string{
		return $this->roomId;
	}

	public function getFormatting() : ?ChatFormatting{
		return $this->formatting;
	}

	protected function decodePayload(ByteBufferReader $in) : void{
		$this->signedChat = SignedChat::read($in);
		$this->roomId = CommonTypes::readOptional($in, CommonTypes::getString(...));
		$this->formatting = CommonTypes::readOptional($in, ChatFormatting::read(...));
	}

	protected function encodePayload(ByteBufferWriter $out) : void{
		$this->signedChat->write($out);
		CommonTypes::writeOptional($out, $this->roomId, CommonTypes::putString(...));
		CommonTypes::writeOptional($out, $this->formatting, static fn(ByteBufferWriter $out, ChatFormatting $chatFormatting) => $chatFormatting->write($out));
	}

	public function handle(PacketHandlerInterface $handler) : bool{
		return $handler->handleChat($this);
	}
}
