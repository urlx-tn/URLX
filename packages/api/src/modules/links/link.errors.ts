export const linkErrorCodes = [
	"EMPTY_URL",
	"INVALID_URL",
	"INVALID_DOMAIN",
	"UNSUPPORTED_PROTOCOL",
	"LOCAL_URL_NOT_ALLOWED",
	"PRIVATE_IP_NOT_ALLOWED",
	"URL_TOO_LONG",
	"RATE_LIMITED",
	"SHORT_CODE_NOT_FOUND",
	"SERVER_ERROR",
] as const;

export type LinkErrorCode = (typeof linkErrorCodes)[number];

const defaultMessages: Record<LinkErrorCode, string> = {
	EMPTY_URL: "Please enter a URL.",
	INVALID_URL: "Please enter a valid http or https URL.",
	INVALID_DOMAIN: "Please enter a valid domain, like example.com.",
	UNSUPPORTED_PROTOCOL: "Only http and https URLs are supported.",
	LOCAL_URL_NOT_ALLOWED: "Local URLs are not allowed.",
	PRIVATE_IP_NOT_ALLOWED: "Private network URLs are not allowed.",
	URL_TOO_LONG: "URLs must be 2048 characters or fewer.",
	RATE_LIMITED: "Please wait a moment before shortening another URL.",
	SHORT_CODE_NOT_FOUND: "Short link not found.",
	SERVER_ERROR: "Something went wrong. Please try again.",
};

const defaultStatuses: Record<LinkErrorCode, number> = {
	EMPTY_URL: 400,
	INVALID_URL: 400,
	INVALID_DOMAIN: 400,
	UNSUPPORTED_PROTOCOL: 400,
	LOCAL_URL_NOT_ALLOWED: 400,
	PRIVATE_IP_NOT_ALLOWED: 400,
	URL_TOO_LONG: 400,
	RATE_LIMITED: 429,
	SHORT_CODE_NOT_FOUND: 404,
	SERVER_ERROR: 500,
};

export class LinkError extends Error {
	readonly code: LinkErrorCode;
	readonly status: number;

	constructor(
		code: LinkErrorCode,
		message = defaultMessages[code],
		status = defaultStatuses[code],
	) {
		super(message);
		this.name = "LinkError";
		this.code = code;
		this.status = status;
	}
}

export function toLinkError(error: unknown) {
	if (error instanceof LinkError) {
		return error;
	}

	return new LinkError("SERVER_ERROR");
}
