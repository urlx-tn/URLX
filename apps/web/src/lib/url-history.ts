const STORAGE_KEY = "urlx:recent-urls";
const LIMIT = 8;

export const getRecentUrls = (): string[] => {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return [];
		}
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed
			.filter((value): value is string => typeof value === "string")
			.slice(0, LIMIT);
	} catch {
		return [];
	}
};

const persist = (urls: string[]): string[] => {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(urls));
	} catch {
		return urls;
	}
	return urls;
};

export const addRecentUrl = (url: string): string[] => {
	const trimmed = url.trim();
	if (!trimmed) {
		return getRecentUrls();
	}
	const next = [
		trimmed,
		...getRecentUrls().filter((value) => value !== trimmed),
	].slice(0, LIMIT);
	return persist(next);
};

export const removeRecentUrl = (url: string): string[] =>
	persist(getRecentUrls().filter((value) => value !== url));
