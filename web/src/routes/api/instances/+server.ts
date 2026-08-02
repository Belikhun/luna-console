import { json } from '@sveltejs/kit';
import { listStatuses } from '$lib/server/luna';
import { listJobs } from '$lib/server/jobs';

/**
 * A placeholder row for an instance that only exists as a running job — a
 * create that has not registered yet, or a purge outliving the registry entry.
 */
function ghostRow(
	name: string,
	state: 'provisioning' | 'deleting',
	daemon: string | null
): Record<string, unknown> {
	return {
		name,
		state,
		software: 'paper',
		mcVersion: null,
		port: null,
		memory: '',
		profile: '',
		javaPid: null,
		uptimeMs: null,
		players: null,
		pingVersion: null,
		cpu: null,
		rssMb: null,
		tps: null,
		heapUsedMb: null,
		heapMaxMb: null,
		lunaStatus: null,
		lunaDisplayName: null,
		lastHeartbeatMs: null,
		ports: {},
		proxy: null,
		external: null,
		daemon,
		dir: '',
		checks: []
	};
}

/**
 * GET → live status of every instance, for the instances table. Rows caught
 * mid-provision or mid-delete are overlaid with that transient state, so every
 * open console sees the transition — not just the browser that started it.
 */
export async function GET() {
	const data = (await listStatuses()) as { instances: Array<Record<string, unknown>> };

	const running = (kind: string) => listJobs(kind).filter((job) => job.state === 'running');

	const creating = running('instance-create');
	const deleting = running('instance-delete');

	for (const row of data.instances) {
		if (deleting.some((job) => job.target === row.name)) {
			row.state = 'deleting';
		} else if (creating.some((job) => job.target === row.name)) {
			row.state = 'provisioning';
		}
	}

	for (const job of creating) {
		if (job.target && !data.instances.some((row) => row.name === job.target)) {
			// the job's meta names the target machine — nothing else knows it yet
			const daemon = (job.meta?.daemon as string | null) ?? null;

			data.instances.push(ghostRow(job.target, 'provisioning', daemon));
		}
	}

	for (const job of deleting) {
		if (job.target && !data.instances.some((row) => row.name === job.target)) {
			const daemon = (job.meta?.daemon as string | null) ?? null;

			data.instances.push(ghostRow(job.target, 'deleting', daemon));
		}
	}

	return json(data);
}
