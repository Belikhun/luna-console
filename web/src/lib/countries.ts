// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * ISO 3166-1 alpha-2 country codes, as the GeoIP database names them. Their
 * names are not kept here: `Intl.DisplayNames` gives each in the reader's
 * language.
 */
export const COUNTRY_CODES: readonly string[] = Object.freeze([
	'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
	'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
	'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
	'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
	'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
	'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
	'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
	'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
	'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
	'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
	'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
	'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
	'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
	'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
	'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
	'VN', 'VU', 'WF', 'WS', 'XK', 'YE', 'YT', 'ZA', 'ZM', 'ZW'
]);

/** The key requests without a country carry in an address (`?country=--`) and in a series (`requests.--`). */
export const NO_COUNTRY = '--';

const regionNames = new Map<string, Intl.DisplayNames>();

/** A country's name in a language; the code itself when the browser knows none. */
export function regionName(code: string, language: string): string {
	let names = regionNames.get(language);

	if (!names) {
		names = new Intl.DisplayNames([language], { type: 'region' });
		regionNames.set(language, names);
	}

	try {
		return names.of(code.toUpperCase()) ?? code;
	} catch {
		return code;
	}
}

/** Every country as a select option, `CC Name`, sorted by name in the language. */
export function countryOptions(language: string): Array<{ value: string; label: string }> {
	const collator = new Intl.Collator(language);

	return COUNTRY_CODES
		.map((code) => ({ code, name: regionName(code, language) }))
		.sort((left, right) => collator.compare(left.name, right.name))
		.map((entry) => ({ value: entry.code, label: `${entry.code} ${entry.name}` }));
}

/**
 * The code a typed country stands for: a code as it is, else the country
 * whose name (in the console's language or in English) is the text, else the
 * only one whose name begins with it. Null when the text names no country, or
 * more than one.
 */
export function countryCodeOf(text: string, language: string): string | null {
	const wanted = text.trim().toLowerCase();

	if (wanted.length < 2) {
		return null;
	}

	if (wanted.length === 2 && COUNTRY_CODES.includes(wanted.toUpperCase())) {
		return wanted.toUpperCase();
	}

	const named = COUNTRY_CODES.map((code) => ({
		code,
		names: [regionName(code, language).toLowerCase(), regionName(code, 'en').toLowerCase()]
	}));
	const exact = named.find((entry) => entry.names.includes(wanted));

	if (exact) {
		return exact.code;
	}

	// a prefix shorter than four letters names too many countries to be a choice
	if (wanted.length < 4) {
		return null;
	}

	const starting = named.filter((entry) => entry.names.some((name) => name.startsWith(wanted)));

	return starting.length === 1
		? starting[0]!.code
		: null;
}
