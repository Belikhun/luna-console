// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Chat channels as the screens name them. The channel is luna-messenger's
 * messaging context on the proxy: the whole network, the server a player is on,
 * or one other player.
 */

import type { ChatChannelFilter, ChatChannelType } from '$core/services/luna';

/** The channels a player can be put in, in the order every menu and filter lists them. */
export const CHAT_CHANNELS: readonly ChatChannelType[] = ['network', 'server', 'direct'];

/** The i18n key naming each channel. */
export const CHAT_CHANNEL_LABEL: Record<ChatChannelType, string> = {
	network: 'web.chatChannel.network',
	server: 'web.chatChannel.server',
	direct: 'web.chatChannel.direct'
};

/** The icon each channel is drawn with. */
export const CHAT_CHANNEL_ICON: Record<ChatChannelType, string> = {
	network: 'globe',
	server: 'server',
	direct: 'envelope'
};

/**
 * Narrow a value from the wire to a channel.
 *
 * @param value what a route or the proxy answered
 * @returns the channel, or null when the value names none (which reads as unknown)
 */
export function chatChannelOf(value: unknown): ChatChannelType | null {
	return typeof value === 'string' && (CHAT_CHANNELS as readonly string[]).includes(value)
		? value as ChatChannelType
		: null;
}

/**
 * Whether a chat log line passes a channel filter. The proxy filters too; this
 * holds the rows to it again because a LunaCore build that predates channels
 * ignores the parameter and answers every line.
 *
 * @param filter the chosen filter, empty for every channel
 * @param entry the line
 * @returns whether to keep it
 */
export function matchesChannelFilter(
	filter: ChatChannelFilter | '',
	entry: { type: string; channel?: string | null }
): boolean {
	if (!filter) {
		return true;
	}

	if (filter === 'unknown') {
		return entry.type === 'chat' && !entry.channel;
	}

	return entry.channel === filter;
}
