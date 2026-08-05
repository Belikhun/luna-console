// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import type { ProgressReporter } from "../core/progress";
import { applySnapshot } from "../shared/progressMirror";
import type { ProgressSnapshot } from "../core/progress";

import { dfetch, followSse } from "./socket";

/**
 * The client half of the RPC bridge: functions built here mirror core
 * signatures exactly; arguments travel to the daemon as JSON, and because the
 * daemon echoes back any cfg/lock argument the core function mutated, the
 * caller's own objects are synced in place afterwards, exactly as if the call
 * had run locally.
 */

interface EchoSpec {
	/** Argument index carrying the ClusterConfig, synced from the echo */
	cfg?: number;
	/** Argument index carrying the PluginsLock, synced from the echo */
	lock?: number;
}

interface JobSpec extends EchoSpec {
	/** Where the caller's reporter sits: argument index, property name when the
	 *  argument is an options object */
	reporter: { arg: number; prop?: string };
	/** Job registry kind (defaults to the op name) */
	kind?: string;
	/** Argument index used as the job's target label */
	targetArg?: number;
}

interface WireResult {
	ok: boolean;
	error?: string;
	result?: unknown;
	cfg?: unknown;
	lock?: unknown;
}

interface WireJob {
	id: string;
	state: "running" | "done" | "failed";
	progress: ProgressSnapshot;
	result: WireResult | { result: unknown; cfg?: unknown; lock?: unknown } | null;
	error: string | null;
}

/** Replace an object's contents with the daemon's echoed copy, in place. */
function syncInto(target: unknown, fresh: unknown): void {
	if (typeof target !== "object" || target === null) {
		return;
	}

	if (typeof fresh !== "object" || fresh === null) {
		return;
	}

	const record = target as Record<string, unknown>;

	for (const key of Object.keys(record)) {
		delete record[key];
	}

	Object.assign(record, fresh);
}

/** Drop trailing undefined arguments so optional parameters stay undefined. */
function trimArgs(args: unknown[]): unknown[] {
	const out = [...args];

	while (out.length > 0 && out[out.length - 1] === undefined) {
		out.pop();
	}

	return out;
}

function applyEchoes(spec: EchoSpec, args: unknown[], body: { cfg?: unknown; lock?: unknown }): void {
	if (spec.cfg !== undefined && body.cfg !== undefined) {
		syncInto(args[spec.cfg], body.cfg);
	}

	if (spec.lock !== undefined && body.lock !== undefined) {
		syncInto(args[spec.lock], body.lock);
	}
}

/**
 * Build a bridge function for one plain RPC op. The result is cast onto the
 * core function's own type at the export site, so call sites keep full typing.
 */
export function call(op: string, spec: EchoSpec = {}): (...args: unknown[]) => Promise<unknown> {
	return async (...args: unknown[]): Promise<unknown> => {
		const response = await dfetch(`/rpc/${encodeURIComponent(op)}`, {
			method: "POST",
			body: JSON.stringify({ args: trimArgs(args) }),
		});

		const body = (await response.json()) as WireResult;

		if (!body.ok) {
			throw new Error(body.error ?? `${op} failed`);
		}

		applyEchoes(spec, args, body);

		return body.result;
	};
}

/**
 * Build a bridge function for a reporter-taking op: it runs as a daemon job,
 * and the job's progress snapshots are mirrored into the caller's local
 * reporter so existing renderers work unchanged.
 */
export function jobCall(op: string, spec: JobSpec): (...args: unknown[]) => Promise<unknown> {
	return async (...args: unknown[]): Promise<unknown> => {
		// pull the local reporter out; everything else crosses the wire
		const { arg, prop } = spec.reporter;
		const wire = [...args];
		let reporter: ProgressReporter | undefined;

		if (prop) {
			const options = wire[arg] as Record<string, unknown> | undefined;

			if (options && options[prop]) {
				reporter = options[prop] as ProgressReporter;

				const { [prop]: _dropped, ...rest } = options;

				wire[arg] = rest;
			}
		} else {
			reporter = wire[arg] as ProgressReporter | undefined;
			wire[arg] = undefined;
		}

		const target = spec.targetArg !== undefined ? String(wire[spec.targetArg] ?? "") : "";

		const startResponse = await dfetch("/jobs", {
			method: "POST",
			body: JSON.stringify({
				op,
				args: trimArgs(wire),
				kind: spec.kind ?? op,
				target,
				label: target ? `${spec.kind ?? op} ${target}` : (spec.kind ?? op),
			}),
		});

		const started = (await startResponse.json()) as { ok: boolean; error?: string; job?: WireJob };

		if (!started.ok || !started.job) {
			throw new Error(started.error ?? `${op} failed to start`);
		}

		let finished: WireJob = started.job;

		await followSse(`/jobs/${started.job.id}?stream=1`, (frame) => {
			finished = frame as WireJob;

			if (reporter) {
				applySnapshot(reporter, finished.progress);
			}
		});

		if (finished.state === "failed") {
			throw new Error(finished.error ?? `${op} failed`);
		}

		const outcome = (finished.result ?? {}) as { result?: unknown; cfg?: unknown; lock?: unknown };

		applyEchoes(spec, args, outcome);

		return outcome.result;
	};
}
