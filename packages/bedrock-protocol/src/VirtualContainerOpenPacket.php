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

use pmmp\encoding\Byte;
use pmmp\encoding\ByteBufferReader;
use pmmp\encoding\ByteBufferWriter;
use pmmp\encoding\VarInt;
use pocketmine\network\mcpe\protocol\serializer\CommonTypes;
use pocketmine\network\mcpe\protocol\types\inventory\ItemStackWrapper;
use function count;

final class VirtualContainerOpenPacket extends DataPacket implements ClientboundPacket{
	public const NETWORK_ID = ProtocolInfo::VIRTUAL_CONTAINER_OPEN_PACKET;

	public const MIN_SLOTS = 1;
	public const MAX_SLOTS = 54;

	private int $containerId;
	private int $sessionId;
	private string $title;
	/** @var ItemStackWrapper[] */
	private array $slots;

	/**
	 * @generate-create-func
	 * @param ItemStackWrapper[] $slots
	 */
	public static function create(int $containerId, int $sessionId, string $title, array $slots) : self{
		$result = new self;
		$result->containerId = $containerId;
		$result->sessionId = $sessionId;
		$result->title = $title;
		$result->slots = $slots;
		return $result;
	}

	public function getContainerId() : int{ return $this->containerId; }

	public function getSessionId() : int{ return $this->sessionId; }

	public function getTitle() : string{ return $this->title; }

	/**
	 * @return ItemStackWrapper[]
	 */
	public function getSlots() : array{ return $this->slots; }

	protected function decodePayload(ByteBufferReader $in) : void{
		$this->containerId = Byte::readUnsigned($in);
		$this->sessionId = VarInt::readUnsignedLong($in);
		$this->title = CommonTypes::getString($in);
		$count = VarInt::readUnsignedInt($in);
		if($count < self::MIN_SLOTS || $count > self::MAX_SLOTS){
			throw new PacketDecodeException("Expected between " . self::MIN_SLOTS . " and " . self::MAX_SLOTS . " slots, got " . $count);
		}
		$this->slots = [];
		for($i = 0; $i < $count; ++$i){
			$this->slots[] = CommonTypes::getItemStackWrapper($in);
		}
	}

	protected function encodePayload(ByteBufferWriter $out) : void{
		Byte::writeUnsigned($out, $this->containerId);
		VarInt::writeUnsignedLong($out, $this->sessionId);
		CommonTypes::putString($out, $this->title);
		VarInt::writeUnsignedInt($out, count($this->slots));
		foreach($this->slots as $slot){
			CommonTypes::putItemStackWrapper($out, $slot);
		}
	}

	public function handle(PacketHandlerInterface $handler) : bool{
		return $handler->handleVirtualContainerOpen($this);
	}
}
