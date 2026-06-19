import { PUBLIC_MARKDOWN_SERVER_URL } from "astro:env/client";

export type MarkdownConversion = {
	sourceUrl: string;
	markdown: string;
};

type MarkdownErrorResponse = {
	code: string;
	message: string;
};

export class MarkdownApiError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "MarkdownApiError";
		this.code = code;
	}
}

export async function convertUrlToMarkdown(
	url: string,
	signal?: AbortSignal,
): Promise<MarkdownConversion> {
	const response = await fetch(`${PUBLIC_MARKDOWN_SERVER_URL}/markdown`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ url }),
		signal,
	});
	const payload: unknown = await response.json();

	if (!response.ok) {
		const error = isMarkdownErrorResponse(payload)
			? payload
			: {
					code: "SERVER_ERROR",
					message: "Something went wrong. Please try again.",
				};
		throw new MarkdownApiError(error.code, error.message);
	}

	if (!isMarkdownConversion(payload)) {
		throw new MarkdownApiError(
			"SERVER_ERROR",
			"The conversion service returned an invalid response.",
		);
	}

	return payload;
}

function isMarkdownConversion(payload: unknown): payload is MarkdownConversion {
	if (!payload || typeof payload !== "object") {
		return false;
	}

	const candidate = payload as Partial<MarkdownConversion>;
	return (
		typeof candidate.sourceUrl === "string" &&
		typeof candidate.markdown === "string"
	);
}

function isMarkdownErrorResponse(
	payload: unknown,
): payload is MarkdownErrorResponse {
	if (!payload || typeof payload !== "object") {
		return false;
	}

	const candidate = payload as Partial<MarkdownErrorResponse>;
	return (
		typeof candidate.code === "string" && typeof candidate.message === "string"
	);
}
