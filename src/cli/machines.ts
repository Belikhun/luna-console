// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { UsageError } from "./framework";
import { listDaemons } from "../client/daemon";
import { machineKeyFor } from "../shared/machines";
import { t } from "../shared/i18n";

/**
 * The `daemon` field a `--daemon <name>` option should write onto an instance.
 * The primary owns its instances by leaving the field absent, so its own name
 * (and "primary") resolve to undefined; passing the name through verbatim files
 * the instance under a machine key nothing else uses, which is how a port
 * already bound on the primary got handed out a second time.
 *
 * @returns undefined for the primary or when no name was given, else the
 *   follower's key
 */
export async function daemonOption(typed: string | undefined): Promise<string | undefined> {
	if (typed === undefined || typed === "" || typed === "primary") {
		return undefined;
	}

	const fleet = await listDaemons();
	const key = machineKeyFor(fleet, typed);

	if (key === undefined) {
		const known = fleet
			.map((row) => row.name)
			.sort()
			.join(", ");

		throw new UsageError(t("cli.machines.unknown", { name: typed, known }));
	}

	if (key === "") {
		return undefined;
	}

	return key;
}
