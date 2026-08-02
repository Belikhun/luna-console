import { json } from '@sveltejs/kit';
import { listJobs } from '$lib/server/jobs';

/**
 * GET → jobs in the registry, filterable by ?target=<name> and ?state=<state>.
 * This is how a page discovers work already in flight for the object it shows
 * — an instance detail opened mid-start attaches its own flash card from here.
 */
export async function GET({ url }) {
	const target = url.searchParams.get('target');
	const state = url.searchParams.get('state');

	let jobs = listJobs();

	if (target !== null) {
		jobs = jobs.filter((job) => job.target === target);
	}

	if (state !== null) {
		jobs = jobs.filter((job) => job.state === state);
	}

	return json({ jobs });
}
