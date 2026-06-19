import { PUBLIC_CONVERSION_SERVER_URL } from "astro:env/client";

export type ConversionFormat = "html" | "markdown";

export type Conversion = {
	sourceUrl: string;
	content: string;
};

type ConversionErrorResponse = {
	code: string;
	message: string;
};

export class ConversionApiError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ConversionApiError";
		this.code = code;
	}
}

export async function convertUrl(
	url: string,
	format: ConversionFormat,
	signal?: AbortSignal,
): Promise<Conversion> {
	const response = await fetch(`${PUBLIC_CONVERSION_SERVER_URL}/${format}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ url }),
		signal,
	});
	const payload: unknown = await response.json();

	if (!response.ok) {
		const error = isConversionErrorResponse(payload)
			? payload
			: {
					code: "SERVER_ERROR",
					message: "Something went wrong. Please try again.",
				};
		throw new ConversionApiError(error.code, error.message);
	}

	if (!isConversion(payload, format)) {
		throw new ConversionApiError(
			"SERVER_ERROR",
			"The conversion service returned an invalid response.",
		);
	}

	return {
		sourceUrl: payload.sourceUrl,
		content: payload[format],
	};
}

function isConversion(
	payload: unknown,
	format: ConversionFormat,
): payload is { sourceUrl: string } & Record<ConversionFormat, string> {
	if (!payload || typeof payload !== "object") {
		return false;
	}

	const candidate = payload as Record<string, unknown>;
	return (
		typeof candidate.sourceUrl === "string" &&
		typeof candidate[format] === "string"
	);
}

function isConversionErrorResponse(
	payload: unknown,
): payload is ConversionErrorResponse {
	if (!payload || typeof payload !== "object") {
		return false;
	}

	const candidate = payload as Partial<ConversionErrorResponse>;
	return (
		typeof candidate.code === "string" && typeof candidate.message === "string"
	);
}
