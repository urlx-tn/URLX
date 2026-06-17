const SCHEME_PREFIX_RE = /^\s*(https?|ftp):\/\//i;
const HTTPS_SCHEME_RE = /^\s*https:\/\//i;
const HTTP_SCHEME_RE = /^https?:\/\//i;
const ANY_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export const stripScheme = (value: string): string =>
	value.replace(SCHEME_PREFIX_RE, "");

export const stripHttpsScheme = (value: string): string =>
	value.replace(HTTPS_SCHEME_RE, "");

export const normalizeUserUrlInput = (raw: string): string => {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const candidate = HTTP_SCHEME_RE.test(trimmed)
		? trimmed
		: ANY_SCHEME_RE.test(trimmed)
			? ""
			: `https://${trimmed}`;
	if (!candidate || !URL.canParse(candidate)) return "";
	return new URL(candidate).toString();
};

export const parseUserUrl = (raw: string): URL | null => {
	const normalized = normalizeUserUrlInput(raw);
	if (!normalized) return null;
	try {
		return new URL(normalized);
	} catch {
		return null;
	}
};

export const isHttpUrl = (raw: string): boolean => {
	const parsed = parseUserUrl(raw);
	if (!parsed) return false;
	return parsed.protocol === "http:" || parsed.protocol === "https:";
};

export const isValidUrl = (raw: string): boolean => {
	const parsed = parseUserUrl(raw);
	if (!parsed) return false;
	const { hostname } = parsed;
	if (!hostname) return false;
	if (hostname === "localhost") return true;
	const bare = hostname.replace(/^\[|\]$/g, "");
	if (URL.canParse(`http://[${bare}]`)) return true;
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return true;
	const labels = hostname.split(".");
	if (labels.length < 2) return false;
	if (labels.some((label) => label.length === 0)) return false;
	const tld = labels[labels.length - 1];
	return /^[a-z]{2,}$/i.test(tld) || /^xn--[a-z0-9]+$/i.test(tld);
};
