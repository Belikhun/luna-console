// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The heap size an instance asks for: one parser, one formatter, one gate.
 *
 * `InstanceConfig.memory` is a JVM-flag string (`2G`, `2200M`) because that is
 * what `-Xms`/`-Xmx` take verbatim, so every screen that wants to reason about
 * it numerically has to convert. Four separate parsers had grown up doing that
 * (one in core, one in the CLI's adopt path, two in the console), each with its
 * own idea of which suffixes count; this is the one they all defer to now.
 *
 * Schema and arithmetic only, deliberately: a Svelte component imports this to
 * drive the memory slider, so it must not reach a module that touches a disk.
 * Same rule as `settings.ts`.
 */

import { t } from "../shared/i18n";

/**
 * Granularity of the memory slider, MB.
 *
 * A quarter of a gigabyte is fine enough that nobody needs the box back to hit
 * the size they meant, and coarse enough that dragging the whole range of a
 * large host stays a handful of dozens of steps rather than thousands.
 */
export const MEMORY_STEP_MB = 256;

/** Least heap worth offering. Below this a Minecraft server will not boot. */
export const MEMORY_MIN_MB = 512;

/** What an instance gets when nobody says. */
export const MEMORY_FALLBACK = "2G";

/** How much heap an instance may ask for: a number and a unit, nothing else. */
const MEMORY_VALUE = /^\d+[kKmMgG]$/;

/**
 * Anything the registry might plausibly hold, including shapes `isMemoryValue`
 * refuses. Reading is deliberately more forgiving than writing: a value scraped
 * out of somebody else's launcher script during `instance adopt` predates our
 * gate, and a screen that cannot parse it shows nothing at all.
 */
const MEMORY_LOOSE = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)b?\s*$/i;

const UNIT_BYTES: Record<string, number> = {
	"": 1024 * 1024,
	k: 1024,
	m: 1024 * 1024,
	g: 1024 * 1024 * 1024,
	t: 1024 * 1024 * 1024 * 1024,
};

/** Whether a string is accepted as a heap size, e.g. `2G`, `2200M`. */
export function isMemoryValue(value: string): boolean {
	return MEMORY_VALUE.test(value.trim());
}

/**
 * A heap string as bytes, or 0 when it cannot be read at all. Unit-less means
 * megabytes, which is how the earliest registries wrote it.
 */
export function memoryBytes(memory: string | undefined): number {
	if (!memory) {
		return 0;
	}

	const match = MEMORY_LOOSE.exec(memory);

	if (!match) {
		return 0;
	}

	return Math.round(Number(match[1]) * (UNIT_BYTES[match[2]!.toLowerCase()] ?? 0));
}

/**
 * A heap string as whole megabytes, or undefined when it cannot be read.
 *
 * Undefined rather than 0, because the callers are pickers and gauges: a slider
 * handed 0 would sit at its floor claiming the instance asks for nothing, where
 * undefined lets it say it cannot show this value and offer the box instead.
 */
export function parseMemoryMb(memory: string | undefined): number | undefined {
	const bytes = memoryBytes(memory);

	if (bytes <= 0) {
		return undefined;
	}

	return Math.round(bytes / 1024 / 1024);
}

/**
 * Megabytes back to the shortest exact heap string: whole gigabytes as `4G`,
 * anything else as `2200M`.
 *
 * Exact matters more than short. Rounding 2200 MB up to `2G` would quietly hand
 * the server 152 MB less than the operator dragged the slider to, and rounding
 * it up to 3G would take memory the machine may not have.
 */
export function formatMemoryMb(mb: number): string {
	const whole = Math.max(1, Math.round(mb));

	return whole % 1024 === 0 ? `${whole / 1024}G` : `${whole}M`;
}

/**
 * Megabytes as a rounded gigabyte figure, for prose.
 *
 * `formatMemoryMb` is exact because its output is stored and handed to the JVM;
 * this one is for a sentence describing a ceiling, where "39 GB" is what a
 * reader wants and "40179M" is arithmetic they did not ask for. One decimal
 * below ten gigabytes, where the difference between 2 and 2.5 matters.
 */
export function formatMemoryGb(mb: number): string {
	const gb = mb / 1024;

	return `${gb < 10 ? gb.toFixed(1) : gb.toFixed(0)} GB`;
}

/** A bare integer with no unit, which the registry has always meant as megabytes. */
const UNITLESS = /^\d+$/;

/**
 * Validate a heap string and return what should be stored, throwing the shared
 * message when it is not one at all.
 *
 * Every write path calls this: `applyInstanceOptions` for an edit and
 * `createInstance` for a new instance, which used to accept anything.
 *
 * A value that already carries a unit is stored exactly as given, so an edit to
 * some other field never rewrites `4096M` into the equivalent `4G` and shows up
 * as churn in `cluster.json`. A **unit-less** one is the exception and is given
 * its `M`: everything in luna reads a bare number as megabytes, but `-Xmx8192`
 * means 8192 *bytes* to the JVM, so storing it verbatim produces a server that
 * cannot start. `instance adopt` is where those come from, scraped out of
 * somebody else's launcher script.
 */
export function assertMemoryValue(value: string): string {
	const trimmed = value.trim();

	if (UNITLESS.test(trimmed)) {
		return `${trimmed}M`;
	}

	// `0M` and `0G` satisfy the shape and mean a heap of nothing, which the JVM
	// refuses to start on; the old regex-only gate let them through to the run
	// script, where the failure looked like a broken server rather than a typo
	if (!isMemoryValue(trimmed) || !parseMemoryMb(trimmed)) {
		throw new Error(t("core.admin.badMemory", { value }));
	}

	return trimmed;
}
