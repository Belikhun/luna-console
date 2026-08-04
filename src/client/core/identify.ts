/**
 * Bridge mirror of core/identify: the matcher itself is pure (it compares hashes
 * the daemon already gathered), and the probes that read files and call providers
 * live on each addon module's bridge — so this file is types plus the pure bits.
 */

export {
	autoUpdateDefault,
	chosenMatch,
	installedFrom,
	matchVersions,
} from "../../core/identify";

export type {
	IdentityMatch,
	IdentityProbe,
	IdentityChoice,
	IdentityConfidence,
	IdentityInstall,
	LocalFile,
	MatchBasis,
} from "../../core/identify";
