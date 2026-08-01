import { json } from '@sveltejs/kit';
import { root } from '$core/config';
import { diskUsage } from '$core/cleanup';
import { readHostMemMb } from '$lib/server/mrds';

/** Host vitals for the console chrome: cluster root, disk usage, total RAM. */
export async function GET() {
	return json({
		root: root(),
		disk: await diskUsage(root()),
		hostMemMb: await readHostMemMb()
	});
}
