export const bioErrorCodes = [
	"EMPTY_TITLE",
	"TITLE_TOO_LONG",
	"DESCRIPTION_TOO_LONG",
	"INVALID_SLUG",
	"RESERVED_SLUG",
	"SLUG_TAKEN",
	"NO_LINKS",
	"TOO_MANY_LINKS",
	"INVALID_LINK_LABEL",
	"PAGE_NOT_FOUND",
	"SERVER_ERROR",
] as const;

export type BioErrorCode = (typeof bioErrorCodes)[number];

const defaultMessages: Record<BioErrorCode, string> = {
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

const defaultStatuses: Record<BioErrorCode, number> = {
	EMPTY_TITLE: 400,
	TITLE_TOO_LONG: 400,
	DESCRIPTION_TOO_LONG: 400,
	INVALID_SLUG: 400,
	RESERVED_SLUG: 400,
	SLUG_TAKEN: 409,
	NO_LINKS: 400,
	TOO_MANY_LINKS: 400,
	INVALID_LINK_LABEL: 400,
	PAGE_NOT_FOUND: 404,
	SERVER_ERROR: 500,
};

export class BioError extends Error {
	readonly code: BioErrorCode;
	readonly status: number;

	constructor(
		code: BioErrorCode,
		message = defaultMessages[code],
		status = defaultStatuses[code],
	) {
		super(message);
		this.name = "BioError";
		this.code = code;
		this.status = status;
	}
}

export function toBioError(error: unknown) {
	if (error instanceof BioError) {
		return error;
	}

	return new BioError("SERVER_ERROR");
}
