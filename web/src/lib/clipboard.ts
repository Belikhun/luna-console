/**
 * Copy text to the clipboard.
 *
 * The console is normally reached over plain HTTP on the LAN (10.0.0.10:8330),
 * which is not a secure context, so `navigator.clipboard` is simply undefined
 * there. Fall back to the legacy hidden-textarea + execCommand path, which still
 * works in every browser we care about.
 *
 * @returns whether the text made it to the clipboard
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through to the legacy path — permission denied, or not focused
	}

	const area = document.createElement('textarea');

	area.value = text;
	area.setAttribute('readonly', '');
	area.style.cssText = 'position: fixed; top: 0; left: 0; opacity: 0; pointer-events: none;';
	document.body.appendChild(area);

	try {
		area.select();
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		area.remove();
	}
}
