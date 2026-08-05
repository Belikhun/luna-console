import { redirect } from '@sveltejs/kit';

/**
 * "/addons" is the nav section, not a screen of its own; a breadcrumb click
 * lands here, so it goes to the groups list rather than a 404.
 */
export function load(): never {
	redirect(307, '/addons/groups');
}
