/**
 * Tooltip singleton, ported from the vloom dashboard's `tooltip` module in
 * src/libs.js: one fixed container is anchored to the hovered element on one of
 * four sides, clamped inside the viewport, and faded in with the dashboard's
 * scale/opacity motion. `TooltipHost` renders it; `tooltip` registers elements.
 */

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipOptions {
	/** a thunk is re-read on hover and by refreshTooltip(), so live text works */
	content: string | (() => string);
	position?: TooltipPosition;
	spacing?: number;
}

interface TooltipStore {
	/** element currently hovered, or null while hiding */
	target: HTMLElement | null;
	content: string;
	position: TooltipPosition;
	/** in the DOM — stays true through the fade-out */
	mounted: boolean;
	/** faded in */
	visible: boolean;
	x: number;
	y: number;
}

/** matches the dashboard's hide delay, so re-entering reuses the same node */
const HIDE_DELAY_MS = 500;
const EDGE_MARGIN = 16;
const DEFAULT_SPACING = 8;

export const TooltipState: TooltipStore = $state({
	target: null,
	content: '',
	position: 'top',
	mounted: false,
	visible: false,
	x: 0,
	y: 0
});

let hideTimer: ReturnType<typeof setTimeout> | undefined;
let activeContent: (() => string) | null = null;

/** Viewport point the card points at, on the requested side of the element. */
function anchorPoint(
	el: HTMLElement,
	position: TooltipPosition,
	spacing: number
): { x: number; y: number } {
	const box = el.getBoundingClientRect();

	switch (position) {
		case 'left':
			return { x: box.x - spacing, y: box.y + box.height / 2 };

		case 'right':
			return { x: box.x + box.width + spacing, y: box.y + box.height / 2 };

		case 'bottom':
			return { x: box.x + box.width / 2, y: box.y + box.height + spacing };

		default:
			return { x: box.x + box.width / 2, y: box.y - spacing };
	}
}

/** Anchor the tooltip to an element and fade it in. */
export function showTooltip(el: HTMLElement, options: TooltipOptions): void {
	const read =
		typeof options.content === 'function' ? options.content : () => options.content as string;

	const text = read();

	if (!text) {
		return;
	}

	clearTimeout(hideTimer);
	hideTimer = undefined;
	activeContent = read;

	const position = options.position ?? 'top';
	const point = anchorPoint(el, position, options.spacing ?? DEFAULT_SPACING);

	TooltipState.target = el;
	TooltipState.content = text;
	TooltipState.position = position;
	TooltipState.x = point.x;
	TooltipState.y = point.y;
	TooltipState.mounted = true;

	// one frame later, so the transition has an initial state to animate from
	requestAnimationFrame(() => {
		if (TooltipState.target === el) {
			TooltipState.visible = true;
		}
	});
}

/** Hide the tooltip. Pass the element to only hide if it is still the active one. */
export function hideTooltip(el?: HTMLElement): void {
	if (el && TooltipState.target !== el) {
		return;
	}

	if (!TooltipState.mounted) {
		return;
	}

	TooltipState.target = null;
	TooltipState.visible = false;
	activeContent = null;

	clearTimeout(hideTimer);

	hideTimer = setTimeout(() => {
		TooltipState.mounted = false;
		hideTimer = undefined;
	}, HIDE_DELAY_MS);
}

/** Re-read the hovered element's content thunk — e.g. "Copy" → "Copied". */
export function refreshTooltip(): void {
	if (TooltipState.target && activeContent) {
		TooltipState.content = activeContent();
	}
}

/**
 * Keep the card inside the viewport. Called by the host once it knows the
 * rendered size, since the anchor point alone can push it off-screen.
 */
export function clampTooltip(width: number, height: number): void {
	const vertical = TooltipState.position === 'top' || TooltipState.position === 'bottom';
	const halfWidth = vertical ? width / 2 : width;
	const halfHeight = vertical ? height : height / 2;

	let { x, y } = TooltipState;

	if (x + halfWidth > window.innerWidth - EDGE_MARGIN) {
		x = window.innerWidth - halfWidth - EDGE_MARGIN;
	} else if (x - halfWidth < 0) {
		x = halfWidth + EDGE_MARGIN;
	}

	if (y + halfHeight > window.innerHeight - EDGE_MARGIN) {
		y = window.innerHeight - halfHeight - EDGE_MARGIN;
	} else if (y - halfHeight < 0) {
		y = halfHeight + EDGE_MARGIN;
	}

	if (x !== TooltipState.x) {
		TooltipState.x = x;
	}

	if (y !== TooltipState.y) {
		TooltipState.y = y;
	}
}

export interface TooltipAction {
	update(next: TooltipOptions): void;
	destroy(): void;
}

/** Svelte action: `use:tooltip={{ content: 'Click to copy', position: 'top' }}`. */
export function tooltip(node: HTMLElement, options: TooltipOptions): TooltipAction {
	let current = options;

	const enter = () => showTooltip(node, current);
	const leave = () => hideTooltip(node);

	node.addEventListener('mouseenter', enter);
	node.addEventListener('mouseleave', leave);

	return {
		update(next: TooltipOptions) {
			current = next;

			if (TooltipState.target === node) {
				showTooltip(node, next);
			}
		},

		destroy() {
			node.removeEventListener('mouseenter', enter);
			node.removeEventListener('mouseleave', leave);
			hideTooltip(node);
		}
	};
}
