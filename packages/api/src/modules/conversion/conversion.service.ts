import {
	checkLayeredRateLimit,
	type RateLimiter,
	type RateLimitIdentity,
} from "../../lib/layered-rate-limit";
import { normalizeUrl } from "../../lib/normalize-url";
import { validateDestinationUrl } from "../../lib/validate-url";
import { ConversionError, type ConversionErrorCode } from "./conversion.errors";

type ConversionRateLimiter = RateLimiter;

export type ConversionFormat = "html" | "markdown";

type ConversionConfig = {
	maxLength: number;
	tooLargeCode: ConversionErrorCode;
	rejectResourceTypes: Array<"font" | "image" | "media" | "stylesheet">;
	waitUntil: "domcontentloaded" | "networkidle2";
};

export type ConversionRenderOptions = {
	url: string;
	format: ConversionFormat;
	timeoutMs: number;
	waitUntil: ConversionConfig["waitUntil"];
	rejectResourceTypes: ConversionConfig["rejectResourceTypes"];
	maxLength: number;
};

export type ConversionRenderer = {
	render(options: ConversionRenderOptions): Promise<string>;
};

const conversionConfigs: Record<ConversionFormat, ConversionConfig> = {
	markdown: {
		maxLength: 1_000_000,
		tooLargeCode: "MARKDOWN_TOO_LARGE",
		rejectResourceTypes: ["image", "media", "font", "stylesheet"],
		waitUntil: "domcontentloaded",
	},
	html: {
		maxLength: 2_000_000,
		tooLargeCode: "HTML_TOO_LARGE",
		rejectResourceTypes: ["image", "media", "font"],
		waitUntil: "networkidle2",
	},
};

export type ConversionServiceOptions = {
	renderer: ConversionRenderer;
	clientIp: string;
	ipRateLimiter: ConversionRateLimiter;
	rateLimitIdentity: RateLimitIdentity;
	visitorRateLimiter: ConversionRateLimiter;
};

export class ConversionService {
	private readonly renderer: ConversionRenderer;
	private readonly clientIp: string;
	private readonly ipRateLimiter: ConversionRateLimiter;
	private readonly rateLimitIdentity: RateLimitIdentity;
	private readonly visitorRateLimiter: ConversionRateLimiter;

	constructor(options: ConversionServiceOptions) {
		this.renderer = options.renderer;
		this.clientIp = options.clientIp;
		this.ipRateLimiter = options.ipRateLimiter;
		this.rateLimitIdentity = options.rateLimitIdentity;
		this.visitorRateLimiter = options.visitorRateLimiter;
	}

	async convert(rawUrl: string, format: ConversionFormat) {
		const sourceUrl = normalizeUrl(validateDestinationUrl(rawUrl).toString());
		const rateLimit = await checkLayeredRateLimit({
			operation: "conversion",
			clientIp: this.clientIp,
			identity: this.rateLimitIdentity,
			ipRateLimiter: this.ipRateLimiter,
			visitorRateLimiter: this.visitorRateLimiter,
		});

		if (!rateLimit.success) {
			throw new ConversionError("RATE_LIMITED");
		}

		const config = conversionConfigs[format];
		const options: ConversionRenderOptions = {
			url: sourceUrl,
			format,
			timeoutMs: 30_000,
			waitUntil: config.waitUntil,
			rejectResourceTypes: config.rejectResourceTypes,
			maxLength: config.maxLength,
		};
		let result: string;

		try {
			result = await this.renderer.render(options);
		} catch (error) {
			if (error instanceof ConversionError) throw error;
			throw new ConversionError("BROWSER_UNAVAILABLE");
		}
		if (result.length > config.maxLength) {
			throw new ConversionError(config.tooLargeCode);
		}

		return {
			sourceUrl,
			result,
		};
	}
}
