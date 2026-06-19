import { normalizeUrl } from "../../lib/normalize-url";
import { validateDestinationUrl } from "../../lib/validate-url";
import { ConversionError, type ConversionErrorCode } from "./conversion.errors";

type BrowserRenderer = Pick<BrowserRun, "quickAction">;
type ConversionRateLimiter = Pick<RateLimit, "limit">;

type BrowserSuccessResponse = {
	success: true;
	result: string;
};

type ConversionFormat = "html" | "markdown";

type ConversionConfig = {
	action: "content" | "markdown";
	maxLength: number;
	tooLargeCode: ConversionErrorCode;
	rejectResourceTypes: Array<"font" | "image" | "media" | "stylesheet">;
	waitUntil: "domcontentloaded" | "networkidle2";
};

const conversionConfigs: Record<ConversionFormat, ConversionConfig> = {
	markdown: {
		action: "markdown",
		maxLength: 1_000_000,
		tooLargeCode: "MARKDOWN_TOO_LARGE",
		rejectResourceTypes: ["image", "media", "font", "stylesheet"],
		waitUntil: "domcontentloaded",
	},
	html: {
		action: "content",
		maxLength: 2_000_000,
		tooLargeCode: "HTML_TOO_LARGE",
		rejectResourceTypes: ["image", "media", "font"],
		waitUntil: "networkidle2",
	},
};

export type ConversionServiceOptions = {
	browser: BrowserRenderer;
	rateLimitKey: string;
	rateLimiter: ConversionRateLimiter;
};

export class ConversionService {
	private readonly browser: BrowserRenderer;
	private readonly rateLimitKey: string;
	private readonly rateLimiter: ConversionRateLimiter;

	constructor(options: ConversionServiceOptions) {
		this.browser = options.browser;
		this.rateLimitKey = options.rateLimitKey;
		this.rateLimiter = options.rateLimiter;
	}

	async convert(rawUrl: string, format: ConversionFormat) {
		const sourceUrl = normalizeUrl(validateDestinationUrl(rawUrl).toString());
		const rateLimit = await this.rateLimiter.limit({
			key: `conversion:${this.rateLimitKey}`,
		});

		if (!rateLimit.success) {
			throw new ConversionError("RATE_LIMITED");
		}

		const config = conversionConfigs[format];
		const options = {
			url: sourceUrl,
			gotoOptions: {
				timeout: 30_000,
				waitUntil: config.waitUntil,
			},
			rejectResourceTypes: config.rejectResourceTypes,
			bestAttempt: true,
			cacheTTL: 300,
		};
		let response: Response;

		try {
			response =
				config.action === "content"
					? await this.browser.quickAction("content", options)
					: await this.browser.quickAction("markdown", options);
		} catch (error) {
			console.error(`Browser Run ${format} request failed`, error);
			throw new ConversionError("BROWSER_UNAVAILABLE");
		}

		if (!response.ok) {
			throw response.status === 429
				? new ConversionError("RATE_LIMITED")
				: response.status >= 500
					? new ConversionError("BROWSER_UNAVAILABLE")
					: new ConversionError("PAGE_FETCH_FAILED");
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new ConversionError("PAGE_FETCH_FAILED");
		}

		if (!isBrowserSuccessResponse(payload)) {
			throw new ConversionError("PAGE_FETCH_FAILED");
		}

		if (payload.result.length > config.maxLength) {
			throw new ConversionError(config.tooLargeCode);
		}

		return {
			sourceUrl,
			result: payload.result,
		};
	}
}

function isBrowserSuccessResponse(
	payload: unknown,
): payload is BrowserSuccessResponse {
	if (!payload || typeof payload !== "object") {
		return false;
	}

	const candidate = payload as Partial<BrowserSuccessResponse>;
	return candidate.success === true && typeof candidate.result === "string";
}
