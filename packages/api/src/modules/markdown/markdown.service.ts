import { normalizeUrl } from "../../lib/normalize-url";
import { validateDestinationUrl } from "../../lib/validate-url";
import { MarkdownError } from "./markdown.errors";
import type { ConvertMarkdownOutput } from "./markdown.schema";

const maxMarkdownLength = 1_000_000;

type MarkdownRenderer = Pick<BrowserRun, "quickAction">;
type MarkdownRateLimiter = Pick<RateLimit, "limit">;

type MarkdownSuccessResponse = {
	success: true;
	result: string;
};

export type MarkdownServiceOptions = {
	browser: MarkdownRenderer;
	rateLimitKey: string;
	rateLimiter: MarkdownRateLimiter;
};

export class MarkdownService {
	private readonly browser: MarkdownRenderer;
	private readonly rateLimitKey: string;
	private readonly rateLimiter: MarkdownRateLimiter;

	constructor(options: MarkdownServiceOptions) {
		this.browser = options.browser;
		this.rateLimitKey = options.rateLimitKey;
		this.rateLimiter = options.rateLimiter;
	}

	async convert(rawUrl: string): Promise<ConvertMarkdownOutput> {
		const sourceUrl = normalizeUrl(validateDestinationUrl(rawUrl).toString());
		const rateLimit = await this.rateLimiter.limit({
			key: `markdown:${this.rateLimitKey}`,
		});

		if (!rateLimit.success) {
			throw new MarkdownError("RATE_LIMITED");
		}

		let response: Response;

		try {
			response = await this.browser.quickAction("markdown", {
				url: sourceUrl,
				gotoOptions: {
					timeout: 30_000,
					waitUntil: "domcontentloaded",
				},
				rejectResourceTypes: ["image", "media", "font", "stylesheet"],
				bestAttempt: true,
				cacheTTL: 300,
			});
		} catch (error) {
			console.error("Browser Run Markdown request failed", error);
			throw new MarkdownError("BROWSER_UNAVAILABLE");
		}

		if (!response.ok) {
			throw response.status === 429
				? new MarkdownError("RATE_LIMITED")
				: response.status >= 500
					? new MarkdownError("BROWSER_UNAVAILABLE")
					: new MarkdownError("PAGE_FETCH_FAILED");
		}

		const payload: unknown = await response.json();

		if (!isMarkdownSuccessResponse(payload)) {
			throw new MarkdownError("PAGE_FETCH_FAILED");
		}

		if (payload.result.length > maxMarkdownLength) {
			throw new MarkdownError("MARKDOWN_TOO_LARGE");
		}

		return {
			sourceUrl,
			markdown: payload.result,
		};
	}
}

function isMarkdownSuccessResponse(
	payload: unknown,
): payload is MarkdownSuccessResponse {
	if (!payload || typeof payload !== "object") {
		return false;
	}

	const candidate = payload as Partial<MarkdownSuccessResponse>;
	return candidate.success === true && typeof candidate.result === "string";
}
