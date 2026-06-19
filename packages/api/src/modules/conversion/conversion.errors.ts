import { LinkError } from "../links/link.errors";

export const conversionErrorCodes = [
	"EMPTY_URL",
	"INVALID_URL",
	"INVALID_DOMAIN",
	"UNSUPPORTED_PROTOCOL",
	"LOCAL_URL_NOT_ALLOWED",
	"PRIVATE_IP_NOT_ALLOWED",
	"URL_TOO_LONG",
	"PAGE_FETCH_FAILED",
	"MARKDOWN_TOO_LARGE",
	"HTML_TOO_LARGE",
	"RATE_LIMITED",
	"BROWSER_UNAVAILABLE",
	"SERVER_ERROR",
] as const;

export type ConversionErrorCode = (typeof conversionErrorCodes)[number];

const defaultMessages: Record<ConversionErrorCode, string> = {
	EMPTY_URL: "Please enter a URL.",
	INVALID_URL: "Please enter a valid http or https URL.",
	INVALID_DOMAIN: "Please enter a valid domain, like example.com.",
	UNSUPPORTED_PROTOCOL: "Only http and https URLs are supported.",
	LOCAL_URL_NOT_ALLOWED: "Local URLs are not allowed.",
	PRIVATE_IP_NOT_ALLOWED: "Private network URLs are not allowed.",
	URL_TOO_LONG: "URLs must be 2048 characters or fewer.",
	PAGE_FETCH_FAILED: "The page could not be converted.",
	MARKDOWN_TOO_LARGE: "The generated Markdown is too large to return.",
	HTML_TOO_LARGE: "The generated HTML is too large to return.",
	RATE_LIMITED: "Too many conversion requests. Please try again shortly.",
	BROWSER_UNAVAILABLE: "The conversion service is temporarily unavailable.",
	SERVER_ERROR: "Something went wrong. Please try again.",
};

const defaultStatuses: Record<ConversionErrorCode, number> = {
	EMPTY_URL: 400,
	INVALID_URL: 400,
	INVALID_DOMAIN: 400,
	UNSUPPORTED_PROTOCOL: 400,
	LOCAL_URL_NOT_ALLOWED: 400,
	PRIVATE_IP_NOT_ALLOWED: 400,
	URL_TOO_LONG: 400,
	PAGE_FETCH_FAILED: 422,
	MARKDOWN_TOO_LARGE: 413,
	HTML_TOO_LARGE: 413,
	RATE_LIMITED: 429,
	BROWSER_UNAVAILABLE: 503,
	SERVER_ERROR: 500,
};

export class ConversionError extends Error {
	readonly code: ConversionErrorCode;
	readonly status: number;

	constructor(
		code: ConversionErrorCode,
		message = defaultMessages[code],
		status = defaultStatuses[code],
	) {
		super(message);
		this.name = "ConversionError";
		this.code = code;
		this.status = status;
	}
}

export function toConversionError(error: unknown) {
	if (error instanceof ConversionError) {
		return error;
	}

	if (error instanceof LinkError && isConversionErrorCode(error.code)) {
		return new ConversionError(error.code, error.message, error.status);
	}

	return new ConversionError("SERVER_ERROR");
}

function isConversionErrorCode(code: string): code is ConversionErrorCode {
	return conversionErrorCodes.some((candidate) => candidate === code);
}
