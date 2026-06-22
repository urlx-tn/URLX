import { LinkError } from "../links/link.errors";

export const metadataErrorCodes = [
	"EMPTY_URL",
	"INVALID_URL",
	"INVALID_DOMAIN",
	"UNSUPPORTED_PROTOCOL",
	"LOCAL_URL_NOT_ALLOWED",
	"PRIVATE_IP_NOT_ALLOWED",
	"URL_TOO_LONG",
	"RATE_LIMITED",
	"TOO_MANY_REDIRECTS",
	"FETCH_TIMEOUT",
	"FETCH_FAILED",
	"SERVER_ERROR",
] as const;

export type MetadataErrorCode = (typeof metadataErrorCodes)[number];

const defaultMessages: Record<MetadataErrorCode, string> = {
	EMPTY_URL: "Please enter a URL.",
	INVALID_URL: "Please enter a valid http or https URL.",
	INVALID_DOMAIN: "Please enter a valid domain, like example.com.",
	UNSUPPORTED_PROTOCOL: "Only http and https URLs are supported.",
	LOCAL_URL_NOT_ALLOWED: "Local URLs are not allowed.",
	PRIVATE_IP_NOT_ALLOWED: "Private network URLs are not allowed.",
	URL_TOO_LONG: "URLs must be 2048 characters or fewer.",
	RATE_LIMITED: "Too many metadata inspections. Please try again shortly.",
	TOO_MANY_REDIRECTS: "The URL redirected too many times.",
	FETCH_TIMEOUT: "The page took too long to respond.",
	FETCH_FAILED: "The page could not be fetched.",
	SERVER_ERROR: "Something went wrong. Please try again.",
};

const defaultStatuses: Record<MetadataErrorCode, number> = {
	EMPTY_URL: 400,
	INVALID_URL: 400,
	INVALID_DOMAIN: 400,
	UNSUPPORTED_PROTOCOL: 400,
	LOCAL_URL_NOT_ALLOWED: 400,
	PRIVATE_IP_NOT_ALLOWED: 400,
	URL_TOO_LONG: 400,
	RATE_LIMITED: 429,
	TOO_MANY_REDIRECTS: 422,
	FETCH_TIMEOUT: 504,
	FETCH_FAILED: 422,
	SERVER_ERROR: 500,
};

export class MetadataError extends Error {
	readonly code: MetadataErrorCode;
	readonly status: number;

	constructor(
		code: MetadataErrorCode,
		message = defaultMessages[code],
		status = defaultStatuses[code],
	) {
		super(message);
		this.name = "MetadataError";
		this.code = code;
		this.status = status;
	}
}

export function toMetadataError(error: unknown) {
	if (error instanceof MetadataError) {
		return error;
	}

	if (error instanceof LinkError && isMetadataErrorCode(error.code)) {
		return new MetadataError(error.code, error.message, error.status);
	}

	return new MetadataError("SERVER_ERROR");
}

function isMetadataErrorCode(code: string): code is MetadataErrorCode {
	return metadataErrorCodes.some((candidate) => candidate === code);
}
