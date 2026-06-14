const STORAGE_KEY = "urlx:recent-urls";
const PREFERENCE_KEY = "urlx:remember-recent-urls";
const LIMIT = 8;

export const isUrlHistoryEnabled = (): boolean => {
	try {
		return localStorage.getItem(PREFERENCE_KEY) === "true";
	} catch {
		return false;
	}
};

export const setUrlHistoryEnabled = (enabled: boolean): boolean => {
	try {
		localStorage.setItem(PREFERENCE_KEY, enabled ? "true" : "false");
	} catch {
		return enabled;
	}
	return enabled;
};

export const getRecentUrls = (): string[] => {
	if (!isUrlHistoryEnabled()) {
		return [];
	}

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

export const clearRecentUrls = (): void => {
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		return;
	}
};
