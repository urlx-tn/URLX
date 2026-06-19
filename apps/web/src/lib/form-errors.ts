const friendlyMessages: Record<string, string> = {
	EMPTY_URL: "Please enter a URL.",
	INVALID_URL: "Please enter a valid http or https URL.",
	INVALID_DOMAIN: "Please enter a valid domain, like example.com.",
	UNSUPPORTED_PROTOCOL: "Please enter a valid http or https URL.",
	LOCAL_URL_NOT_ALLOWED: "Local URLs cannot be shortened.",
	PRIVATE_IP_NOT_ALLOWED: "Private network URLs cannot be shortened.",
	URL_TOO_LONG: "This URL is too long.",
	RATE_LIMITED: "Too many requests. Please try again shortly.",
	PAGE_FETCH_FAILED:
		"This page could not be converted. It may block automated access.",
	MARKDOWN_TOO_LARGE: "This page produced too much Markdown to return.",
	HTML_TOO_LARGE: "This page produced too much HTML to return.",
	BROWSER_UNAVAILABLE:
		"The conversion service is temporarily unavailable. Please try again.",
	EMPTY_TITLE: "Please enter a title for your page.",
	TITLE_TOO_LONG: "Titles must be 80 characters or fewer.",
	DESCRIPTION_TOO_LONG: "Descriptions must be 300 characters or fewer.",
	INVALID_SLUG:
		"Handles may use 3-30 letters, numbers, and hyphens, and cannot start or end with a hyphen.",
	RESERVED_SLUG: "That handle is reserved. Please choose another.",
	SLUG_TAKEN: "That handle is already taken. Please choose another.",
	NO_LINKS: "Please add at least one link.",
	TOO_MANY_LINKS: "You can add up to 25 links.",
	INVALID_LINK_LABEL: "Each link needs a label of 60 characters or fewer.",
	PAGE_NOT_FOUND: "Page not found.",
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
