import { isHttpUrl, parseUserUrl } from "./url-tools";

export const TRACKING_PARAMS = [
	"fbclid",
	"gclid",
	"gbraid",
	"wbraid",
	"dclid",
	"msclkid",
	"yclid",
	"mc_cid",
	"mc_eid",
	"_hsenc",
	"_hsmi",
	"igshid",
];

export type CleanUrlSuccess = {
	ok: true;
	cleanedUrl: string;
	removedCount: number;
	removedNames: string[];
};

export type CleanUrlError = {
	ok: false;
	error: string;
};

export type CleanUrlResult = CleanUrlSuccess | CleanUrlError;

const HTTPS_URL_RE = /^https:\/\//i;
const UNSUPPORTED_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

const isTrackingParam = (key: string): boolean => {
	const lower = key.toLowerCase();
	if (lower.startsWith("utm_")) return true;
	return TRACKING_PARAMS.includes(lower);
};

export const isCleanableUrl = (rawInput: string): boolean => {
	const trimmed = rawInput.trim();
	if (UNSUPPORTED_SCHEME_RE.test(trimmed) && !HTTPS_URL_RE.test(trimmed)) {
		return false;
	}

	return isHttpUrl(rawInput);
};

export const cleanUrl = (rawInput: string): CleanUrlResult => {
	const parsed = parseUserUrl(rawInput);
	if (!parsed || !isCleanableUrl(rawInput)) {
		return {
			ok: false,
			error: "Please enter a valid HTTPS URL.",
		};
	}

	const removedNames: string[] = [];
	let removedCount = 0;
	const keptParams = new URLSearchParams();

	for (const [key, value] of parsed.searchParams) {
		if (isTrackingParam(key)) {
			removedCount += 1;
			if (!removedNames.includes(key)) {
				removedNames.push(key);
			}
		} else {
			keptParams.append(key, value);
		}
	}

	const cleaned = new URL(parsed.toString());
	cleaned.search = keptParams.toString();

	return {
		ok: true,
		cleanedUrl: cleaned.toString(),
		removedCount,
		removedNames,
	};
};
