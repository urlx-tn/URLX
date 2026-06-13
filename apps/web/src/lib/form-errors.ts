const friendlyMessages: Record<string, string> = {
	EMPTY_URL: "Please enter a URL.",
	INVALID_URL: "Please enter a valid http or https URL.",
	UNSUPPORTED_PROTOCOL: "Please enter a valid http or https URL.",
	LOCAL_URL_NOT_ALLOWED: "Local URLs cannot be shortened.",
	PRIVATE_IP_NOT_ALLOWED: "Private network URLs cannot be shortened.",
	URL_TOO_LONG: "This URL is too long.",
	RATE_LIMITED: "Too many requests. Please try again shortly.",
	SERVER_ERROR: "Something went wrong. Please try again.",
};

const fallbackMessage = "Something went wrong. Please try again.";

const readCode = (error: unknown): string | undefined => {
	if (error && typeof error === "object") {
		const data = (error as { data?: unknown }).data;
		if (data && typeof data === "object") {
			const code = (data as { code?: unknown }).code;
			if (typeof code === "string") {
				return code;
			}
		}
		const direct = (error as { code?: unknown }).code;
		if (typeof direct === "string") {
			return direct;
		}
	}
	return undefined;
};

export const friendlyErrorMessage = (error: unknown): string => {
	const code = readCode(error);
	if (code && code in friendlyMessages) {
		return friendlyMessages[code];
	}
	return fallbackMessage;
};
