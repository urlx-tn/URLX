import { LinkError } from "../links/link.errors";

export const markdownErrorCodes = [
	"EMPTY_URL",
	"INVALID_URL",
	"INVALID_DOMAIN",
	"UNSUPPORTED_PROTOCOL",
	"LOCAL_URL_NOT_ALLOWED",
	"PRIVATE_IP_NOT_ALLOWED",
	"URL_TOO_LONG",
	"PAGE_FETCH_FAILED",
	"MARKDOWN_TOO_LARGE",
	"RATE_LIMITED",
	"BROWSER_UNAVAILABLE",
	"SERVER_ERROR",
] as const;

export type MarkdownErrorCode = (typeof markdownErrorCodes)[number];

const defaultMessages: Record<MarkdownErrorCode, string> = {
	EMPTY_URL: "Please enter a URL.",
	INVALID_URL: "Please enter a valid http or https URL.",
	INVALID_DOMAIN: "Please enter a valid domain, like example.com.",
	UNSUPPORTED_PROTOCOL: "Only http and https URLs are supported.",
	LOCAL_URL_NOT_ALLOWED: "Local URLs are not allowed.",
	PRIVATE_IP_NOT_ALLOWED: "Private network URLs are not allowed.",
	URL_TOO_LONG: "URLs must be 2048 characters or fewer.",
	PAGE_FETCH_FAILED: "The page could not be converted to Markdown.",
	MARKDOWN_TOO_LARGE: "The generated Markdown is too large to return.",
	RATE_LIMITED: "Too many conversion requests. Please try again shortly.",
	BROWSER_UNAVAILABLE: "The conversion service is temporarily unavailable.",
	SERVER_ERROR: "Something went wrong. Please try again.",
};

const defaultStatuses: Record<MarkdownErrorCode, number> = {
	EMPTY_URL: 400,
	INVALID_URL: 400,
	INVALID_DOMAIN: 400,
	UNSUPPORTED_PROTOCOL: 400,
	LOCAL_URL_NOT_ALLOWED: 400,
	PRIVATE_IP_NOT_ALLOWED: 400,
	URL_TOO_LONG: 400,
	PAGE_FETCH_FAILED: 422,
	MARKDOWN_TOO_LARGE: 413,
	RATE_LIMITED: 429,
	BROWSER_UNAVAILABLE: 503,
	SERVER_ERROR: 500,
};

export class MarkdownError extends Error {
	readonly code: MarkdownErrorCode;
	readonly status: number;

	constructor(
		code: MarkdownErrorCode,
		message = defaultMessages[code],
		status = defaultStatuses[code],
	) {
		super(message);
		this.name = "MarkdownError";
		this.code = code;
		this.status = status;
	}
}

export function toMarkdownError(error: unknown) {
	if (error instanceof MarkdownError) {
		return error;
	}

	if (error instanceof LinkError && isMarkdownErrorCode(error.code)) {
		return new MarkdownError(error.code, error.message, error.status);
	}

	return new MarkdownError("SERVER_ERROR");
}

function isMarkdownErrorCode(code: string): code is MarkdownErrorCode {
	return markdownErrorCodes.some((candidate) => candidate === code);
}
