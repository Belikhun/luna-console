// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * What Mèo Béo's `console_screenshot` sees: the console as the operator has it
 * on screen right now (top bar, side nav, the page and whatever it scrolled
 * to), drawn from the live DOM in this browser, without the chat panel itself.
 *
 * The panel is filtered out of the render and then cropped off, because the
 * render keeps every element at the width it has on screen: dropping the panel
 * alone would leave an empty strip where it was.
 */

import { domToCanvas } from 'modern-screenshot';

/** The longest edge sent to the model; larger images are scaled down by the API anyway. */
const MAX_EDGE_PX = 1568;

const JPEG_QUALITY = 0.85;

export interface ConsoleShot {
	image: Blob;
	/** The page path, as the operator's address bar has it */
	page: string;
	/** The captured area in CSS pixels */
	width: number;
	height: number;
}

/** Render the console beside the chat panel to a JPEG. `panelWidth` is the docked panel's width in CSS px. */
export async function captureConsole(panelWidth: number): Promise<ConsoleShot> {
	const root = document.querySelector<HTMLElement>('.app') ?? document.body;
	const width = Math.max(320, window.innerWidth - panelWidth);
	const height = window.innerHeight;
	const scale = Math.min(1, MAX_EDGE_PX / Math.max(width, height));

	const full = await domToCanvas(root, {
		scale,
		backgroundColor: getComputedStyle(document.body).backgroundColor,
		filter: (node) => !(node instanceof HTMLElement && node.tagName === 'ASIDE' && node.classList.contains('agent'))
	});

	const cropped = document.createElement('canvas');

	cropped.width = Math.round(width * scale);
	cropped.height = Math.round(height * scale);
	cropped.getContext('2d')?.drawImage(full, 0, 0, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);

	const image = await new Promise<Blob>((resolve, reject) => {
		cropped.toBlob(
			(blob) => {
				if (blob) {
					resolve(blob);
				} else {
					reject(new Error('the browser could not encode the screenshot'));
				}
			},
			'image/jpeg',
			JPEG_QUALITY
		);
	});

	return {
		image,
		page: `${location.pathname}${location.search}`,
		width,
		height
	};
}
