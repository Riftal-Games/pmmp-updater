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

namespace pocketmine\network\mcpe\protocol\types\resourcepacks;

use pocketmine\network\mcpe\protocol\ResourcePackStackPacket;

/**
 * Flags, combined with `|`, naming which Editor packs go on the client's pack stack.
 * Unknown bits pass through unchecked, as the schema allows unknown values.
 *
 * @see ResourcePackStackPacket::$editorPackTypes
 */
final class EditorPackType{

	private function __construct(){
		//NOOP
	}

	public const NONE = 0;
	public const CORE = 0x1;
	public const ANNOTATION = 0x2;
}
