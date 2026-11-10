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

/**
 * How long the client waits before retrying lost data. DEFAULT keeps its usual delays; FAST and BALANCED allow
 * shorter ones. The client applies a profile without reconnecting.
 */
enum SctpRecoveryProfile : int{
	use PacketIntEnumTrait;

	case DEFAULT = 0;
	case FAST = 1;
	case BALANCED = 2;
}
