import { Parser } from "htmlparser2";

import { normalizeUrl } from "../../lib/normalize-url";
import { validateDestinationUrl } from "../../lib/validate-url";
import { MetadataError } from "./metadata.errors";
import type { InspectMetadataOutput, MetadataWarning } from "./metadata.schema";

type MetadataRateLimiter = Pick<RateLimit, "limit">;
type MetadataFetcher = typeof fetch;
type MetadataClock = () => Date;

type HtmlReadResult = {
	html: string;
	truncated: boolean;
	headClosed: boolean;
};

type RawTag = InspectMetadataOutput["rawTags"][number];
type MetadataImage = InspectMetadataOutput["openGraph"]["images"][number];
type WarningSeverity = MetadataWarning["severity"];

type ParsedMetadata = Pick<
	InspectMetadataOutput,
	| "title"
	| "description"
	| "canonicalUrl"
	| "language"
	| "charset"
	| "viewport"
	| "robots"
	| "themeColor"
	| "faviconUrl"
	| "openGraph"
	| "twitter"
	| "rawTags"
> & {
	warnings: MetadataWarning[];
};

export type MetadataServiceOptions = {
	fetcher: MetadataFetcher;
	now: MetadataClock;
	rateLimitKey: string;
	rateLimiter: MetadataRateLimiter;
};

const maxRedirects = 5;
const maxHtmlBytes = 1_048_576;
const maxRawTags = 100;
const maxRawValueLength = 500;
const maxWarnings = 30;
const fetchTimeoutMs = 8_000;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export class MetadataService {
	private readonly fetcher: MetadataFetcher;
	private readonly now: MetadataClock;
	private readonly rateLimitKey: string;
	private readonly rateLimiter: MetadataRateLimiter;

	constructor(options: MetadataServiceOptions) {
		this.fetcher = options.fetcher;
		this.now = options.now;
		this.rateLimitKey = options.rateLimitKey;
		this.rateLimiter = options.rateLimiter;
	}

	async inspect(rawUrl: string): Promise<InspectMetadataOutput> {
		const sourceUrl = normalizeUrl(validateDestinationUrl(rawUrl).toString());
		const rateLimit = await this.rateLimiter.limit({
			key: `metadata:${this.rateLimitKey}`,
		});

		if (!rateLimit.success) {
			throw new MetadataError("RATE_LIMITED");
		}

		const { response, finalUrl, redirects } =
			await this.fetchWithRedirects(sourceUrl);
		const checkedAt = this.now().toISOString();
		const contentType = response.headers.get("content-type");
		const warnings: MetadataWarning[] = [];

		if (!isHtmlContentType(contentType)) {
			addWarning(
				warnings,
				"NON_HTML_CONTENT_TYPE",
				"warning",
				"The response is not HTML, so metadata could not be extracted.",
			);

			return emptyResult({
				checkedAt,
				contentType,
				finalUrl,
				ok: response.ok,
				redirects,
				sourceUrl,
				status: response.status,
				warnings,
			});
		}

		const read = await readHtmlHead(response);
		if (read.truncated) {
			addWarning(
				warnings,
				"HTML_TRUNCATED",
				"warning",
				"Only the first 1 MiB of HTML was inspected.",
			);
		}

		const parsed = parseMetadata(read.html, finalUrl);
		warnings.push(...parsed.warnings);
		if (!read.headClosed && read.truncated) {
			addWarning(
				warnings,
				"HTML_TRUNCATED_BEFORE_HEAD_END",
				"warning",
				"HTML was truncated before the metadata section ended.",
			);
		}

		if (!response.ok) {
			addWarning(
				warnings,
				"NON_OK_STATUS",
				"warning",
				`The page returned HTTP ${response.status}.`,
			);
		}

		const preview = buildPreview(parsed, finalUrl, warnings);

		return {
			sourceUrl,
			finalUrl,
			status: response.status,
			ok: response.ok,
			contentType,
			checkedAt,
			redirects,
			title: parsed.title,
			description: parsed.description,
			canonicalUrl: parsed.canonicalUrl,
			language: parsed.language,
			charset: parsed.charset,
			viewport: parsed.viewport,
			robots: parsed.robots,
			themeColor: parsed.themeColor,
			faviconUrl: parsed.faviconUrl,
			openGraph: parsed.openGraph,
			twitter: parsed.twitter,
			preview,
			rawTags: parsed.rawTags,
			warnings: warnings.slice(0, maxWarnings),
		};
	}

	private async fetchWithRedirects(sourceUrl: string) {
		let currentUrl = sourceUrl;
		const seenUrls = new Set([sourceUrl]);
		const redirects: InspectMetadataOutput["redirects"] = [];

		for (
			let requestIndex = 0;
			requestIndex <= maxRedirects;
			requestIndex += 1
		) {
			const response = await this.fetchOnce(currentUrl);
			const location = response.headers.get("location");

			if (!redirectStatuses.has(response.status) || !location) {
				return { response, finalUrl: currentUrl, redirects };
			}

			if (redirects.length >= maxRedirects) {
				throw new MetadataError("TOO_MANY_REDIRECTS");
			}

			const nextUrl = resolveAndValidateRedirect(location, currentUrl);
			if (seenUrls.has(nextUrl)) {
				throw new MetadataError("TOO_MANY_REDIRECTS");
			}

			redirects.push({
				from: currentUrl,
				to: nextUrl,
				status: response.status,
			});
			seenUrls.add(nextUrl);
			currentUrl = nextUrl;
		}

		throw new MetadataError("TOO_MANY_REDIRECTS");
	}

	private async fetchOnce(url: string) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);

		try {
			return await this.fetcher(url, {
				method: "GET",
				redirect: "manual",
				headers: {
					Accept: "text/html,application/xhtml+xml",
					"User-Agent": "URLX Metadata Inspector (+https://www.urlx.tn)",
				},
				signal: controller.signal,
			});
		} catch (error) {
			if (isAbortError(error)) {
				throw new MetadataError("FETCH_TIMEOUT");
			}

			throw new MetadataError("FETCH_FAILED");
		} finally {
			clearTimeout(timer);
		}
	}
}

function emptyResult(options: {
	checkedAt: string;
	contentType: string | null;
	finalUrl: string;
	ok: boolean;
	redirects: InspectMetadataOutput["redirects"];
	sourceUrl: string;
	status: number;
	warnings: MetadataWarning[];
}): InspectMetadataOutput {
	return {
		sourceUrl: options.sourceUrl,
		finalUrl: options.finalUrl,
		status: options.status,
		ok: options.ok,
		contentType: options.contentType,
		checkedAt: options.checkedAt,
		redirects: options.redirects,
		title: null,
		description: null,
		canonicalUrl: null,
		language: null,
		charset: null,
		viewport: null,
		robots: null,
		themeColor: null,
		faviconUrl: null,
		openGraph: {
			title: null,
			description: null,
			url: null,
			type: null,
			siteName: null,
			locale: null,
			images: [],
		},
		twitter: {
			card: null,
			site: null,
			creator: null,
			title: null,
			description: null,
			image: null,
			imageAlt: null,
		},
		preview: {
			title: null,
			description: null,
			imageUrl: null,
			imageAlt: null,
			siteName: new URL(options.finalUrl).hostname,
			url: options.finalUrl,
			faviconUrl: null,
		},
		rawTags: [],
		warnings: options.warnings.slice(0, maxWarnings),
	};
}

async function readHtmlHead(response: Response): Promise<HtmlReadResult> {
	if (!response.body) {
		const html = (await response.text()).slice(0, maxHtmlBytes);
		return {
			html: sliceThroughHead(html),
			truncated: html.length >= maxHtmlBytes,
			headClosed: hasHeadClose(html),
		};
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let bytesRead = 0;
	let truncated = false;
	let headClosed = false;

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			chunks.push(decoder.decode());
			break;
		}

		const remaining = maxHtmlBytes - bytesRead;
		if (remaining <= 0) {
			truncated = true;
			await reader.cancel();
			break;
		}

		const chunk =
			value.byteLength > remaining ? value.slice(0, remaining) : value;
		bytesRead += chunk.byteLength;
		chunks.push(decoder.decode(chunk, { stream: true }));

		const currentHtml = chunks.join("");
		const headEnd = currentHtml.search(/<\/head\s*>/i);
		if (headEnd >= 0) {
			headClosed = true;
			chunks.splice(0, chunks.length, currentHtml.slice(0, headEnd + 7));
			await reader.cancel();
			break;
		}

		if (value.byteLength > remaining) {
			truncated = true;
			await reader.cancel();
			break;
		}
	}

	const html = chunks.join("");
	return {
		html,
		truncated,
		headClosed: headClosed || hasHeadClose(html),
	};
}

function parseMetadata(html: string, finalUrl: string): ParsedMetadata {
	const warnings: MetadataWarning[] = [];
	const rawTags: RawTag[] = [];
	const images: MetadataImage[] = [];
	const openGraph = {
		title: null as string | null,
		description: null as string | null,
		url: null as string | null,
		type: null as string | null,
		siteName: null as string | null,
		locale: null as string | null,
		images,
	};
	const twitter = {
		card: null as string | null,
		site: null as string | null,
		creator: null as string | null,
		title: null as string | null,
		description: null as string | null,
		image: null as string | null,
		imageAlt: null as string | null,
	};
	let title: string | null = null;
	let titleBuffer = "";
	let inTitle = false;
	let description: string | null = null;
	let canonicalUrl: string | null = null;
	let language: string | null = null;
	let charset: string | null = null;
	let viewport: string | null = null;
	let robots: string | null = null;
	let themeColor: string | null = null;
	let faviconUrl: string | null = null;
	let currentImage: MetadataImage | null = null;

	const parser = new Parser(
		{
			onopentag(name, attributes) {
				const tagName = name.toLowerCase();
				const attrs = lowerCaseAttributes(attributes);

				if (tagName === "html") {
					language = firstValue(language, cleanText(attrs.lang));
					if (attrs.lang) {
						pushRawTag(rawTags, "html", "lang", attrs.lang);
					}
					return;
				}

				if (tagName === "title") {
					inTitle = true;
					titleBuffer = "";
					return;
				}

				if (tagName === "meta") {
					handleMeta(attrs);
					return;
				}

				if (tagName === "link") {
					handleLink(attrs);
				}
			},
			ontext(text) {
				if (inTitle) {
					titleBuffer += text;
				}
			},
			onclosetag(name) {
				if (name.toLowerCase() === "title") {
					inTitle = false;
					title = firstValue(title, cleanText(titleBuffer));
					if (title) {
						pushRawTag(rawTags, "title", "title", title);
					}
				}
			},
		},
		{ decodeEntities: true },
	);

	function handleMeta(attrs: Record<string, string>) {
		if (attrs.charset) {
			charset = firstValue(charset, cleanText(attrs.charset));
			pushRawTag(rawTags, "meta", "charset", attrs.charset);
			return;
		}

		const httpEquiv = cleanText(attrs["http-equiv"]);
		const name = cleanText(attrs.property ?? attrs.name ?? httpEquiv ?? "");
		const value = cleanText(attrs.content);
		if (!name || !value) {
			return;
		}

		const key = name.toLowerCase();
		pushRawTag(rawTags, "meta", key, value);

		if (key === "description") {
			description = firstValue(description, value);
		} else if (key === "viewport") {
			viewport = firstValue(viewport, value);
		} else if (key === "robots") {
			robots = firstValue(robots, value);
		} else if (key === "theme-color") {
			themeColor = firstValue(themeColor, value);
		} else if (key === "content-type") {
			charset = firstValue(charset, charsetFromContent(value));
		} else if (key.startsWith("og:")) {
			handleOpenGraph(key, value);
		} else if (key.startsWith("twitter:")) {
			handleTwitter(key, value);
		}
	}

	function handleLink(attrs: Record<string, string>) {
		const rel = cleanText(attrs.rel)?.toLowerCase();
		const href = cleanText(attrs.href);
		if (!rel || !href) {
			return;
		}

		pushRawTag(rawTags, "link", rel, href);
		if (rel.split(/\s+/).includes("canonical")) {
			canonicalUrl = firstValue(
				canonicalUrl,
				resolveMetadataUrl(href, finalUrl, warnings),
			);
		}
		if (!faviconUrl && rel.includes("icon")) {
			faviconUrl = resolveMetadataUrl(href, finalUrl, warnings);
		}
	}

	function handleOpenGraph(key: string, value: string) {
		if (key === "og:title") {
			openGraph.title = firstValue(openGraph.title, value);
		} else if (key === "og:description") {
			openGraph.description = firstValue(openGraph.description, value);
		} else if (key === "og:url") {
			openGraph.url = firstValue(
				openGraph.url,
				resolveMetadataUrl(value, finalUrl, warnings),
			);
		} else if (key === "og:type") {
			openGraph.type = firstValue(openGraph.type, value);
		} else if (key === "og:site_name") {
			openGraph.siteName = firstValue(openGraph.siteName, value);
		} else if (key === "og:locale") {
			openGraph.locale = firstValue(openGraph.locale, value);
		} else if (key === "og:image" || key === "og:image:url") {
			const imageUrl = resolveMetadataUrl(value, finalUrl, warnings);
			if (imageUrl) {
				currentImage = {
					url: imageUrl,
					secureUrl: null,
					type: null,
					width: null,
					height: null,
					alt: null,
				};
				images.push(currentImage);
			}
		} else if (currentImage && key === "og:image:secure_url") {
			currentImage.secureUrl = firstValue(
				currentImage.secureUrl,
				resolveMetadataUrl(value, finalUrl, warnings),
			);
		} else if (currentImage && key === "og:image:type") {
			currentImage.type = firstValue(currentImage.type, value);
		} else if (currentImage && key === "og:image:width") {
			currentImage.width = firstValue(
				currentImage.width,
				parsePositiveInt(value),
			);
		} else if (currentImage && key === "og:image:height") {
			currentImage.height = firstValue(
				currentImage.height,
				parsePositiveInt(value),
			);
		} else if (currentImage && key === "og:image:alt") {
			currentImage.alt = firstValue(currentImage.alt, value);
		}
	}

	function handleTwitter(key: string, value: string) {
		if (key === "twitter:card") {
			twitter.card = firstValue(twitter.card, value);
		} else if (key === "twitter:site") {
			twitter.site = firstValue(twitter.site, value);
		} else if (key === "twitter:creator") {
			twitter.creator = firstValue(twitter.creator, value);
		} else if (key === "twitter:title") {
			twitter.title = firstValue(twitter.title, value);
		} else if (key === "twitter:description") {
			twitter.description = firstValue(twitter.description, value);
		} else if (key === "twitter:image") {
			twitter.image = firstValue(
				twitter.image,
				resolveMetadataUrl(value, finalUrl, warnings),
			);
		} else if (key === "twitter:image:alt") {
			twitter.imageAlt = firstValue(twitter.imageAlt, value);
		}
	}

	parser.write(html);
	parser.end();

	return {
		title,
		description,
		canonicalUrl,
		language,
		charset,
		viewport,
		robots,
		themeColor,
		faviconUrl,
		openGraph,
		twitter,
		rawTags,
		warnings,
	};
}

function buildPreview(
	metadata: ParsedMetadata,
	finalUrl: string,
	warnings: MetadataWarning[],
): InspectMetadataOutput["preview"] {
	const preview = {
		title: metadata.openGraph.title ?? metadata.twitter.title ?? metadata.title,
		description:
			metadata.openGraph.description ??
			metadata.twitter.description ??
			metadata.description,
		imageUrl: metadata.openGraph.images[0]?.url ?? metadata.twitter.image,
		imageAlt: metadata.openGraph.images[0]?.alt ?? metadata.twitter.imageAlt,
		siteName: metadata.openGraph.siteName ?? new URL(finalUrl).hostname,
		url: metadata.openGraph.url ?? metadata.canonicalUrl ?? finalUrl,
		faviconUrl: metadata.faviconUrl,
	};

	if (!preview.title) {
		addWarning(warnings, "MISSING_TITLE", "warning", "No preview title found.");
	}
	if (!preview.description) {
		addWarning(
			warnings,
			"MISSING_DESCRIPTION",
			"warning",
			"No preview description found.",
		);
	}
	if (!metadata.openGraph.images[0]) {
		addWarning(warnings, "MISSING_OG_IMAGE", "warning", "No og:image found.");
	} else if (!metadata.openGraph.images[0].alt) {
		addWarning(
			warnings,
			"MISSING_OG_IMAGE_ALT",
			"info",
			"The primary og:image does not include alt text.",
		);
	}
	if (!metadata.canonicalUrl) {
		addWarning(
			warnings,
			"MISSING_CANONICAL_URL",
			"info",
			"No canonical URL found.",
		);
	}
	if (preview.imageUrl && !preview.imageUrl.startsWith("https://")) {
		addWarning(
			warnings,
			"NON_HTTPS_PREVIEW_IMAGE",
			"warning",
			"The preview image is not served over HTTPS.",
		);
	}
	if (metadata.openGraph.url && metadata.openGraph.url !== finalUrl) {
		addWarning(
			warnings,
			"FINAL_URL_DIFFERS_FROM_OG_URL",
			"info",
			"The final URL differs from og:url.",
		);
	}

	return preview;
}

function resolveAndValidateRedirect(location: string, baseUrl: string) {
	let nextUrl: string;
	try {
		nextUrl = new URL(location, baseUrl).toString();
	} catch {
		throw new MetadataError("INVALID_URL");
	}

	return normalizeUrl(validateDestinationUrl(nextUrl).toString());
}

function resolveMetadataUrl(
	value: string,
	baseUrl: string,
	warnings: MetadataWarning[],
) {
	try {
		const resolved = new URL(value, baseUrl);
		if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
			throw new Error("Unsupported metadata URL protocol");
		}
		return normalizeUrl(validateDestinationUrl(resolved.toString()).toString());
	} catch {
		addWarning(
			warnings,
			"INVALID_METADATA_URL",
			"warning",
			`Invalid metadata URL ignored: ${truncate(value, 80)}`,
		);
		return null;
	}
}

function pushRawTag(
	rawTags: RawTag[],
	source: RawTag["source"],
	name: string,
	value: string,
) {
	if (rawTags.length >= maxRawTags) {
		return;
	}

	rawTags.push({
		source,
		name: truncate(name, 80),
		value: truncate(value, maxRawValueLength),
	});
}

function addWarning(
	warnings: MetadataWarning[],
	code: string,
	severity: WarningSeverity,
	message: string,
) {
	if (warnings.length >= maxWarnings) {
		return;
	}

	if (warnings.some((warning) => warning.code === code)) {
		return;
	}

	warnings.push({ code, severity, message });
}

function lowerCaseAttributes(attributes: Record<string, string>) {
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(attributes)) {
		normalized[key.toLowerCase()] = value;
	}
	return normalized;
}

function firstValue<T>(current: T | null, next: T | null | undefined) {
	return current ?? next ?? null;
}

function cleanText(value: string | undefined) {
	const cleaned = value?.replace(/\s+/g, " ").trim();
	return cleaned ? cleaned : null;
}

function charsetFromContent(value: string) {
	return /charset=([^;]+)/i.exec(value)?.[1]?.trim() ?? null;
}

function parsePositiveInt(value: string) {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isHtmlContentType(contentType: string | null) {
	if (!contentType) {
		return true;
	}

	return /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
}

function isAbortError(error: unknown) {
	return error instanceof DOMException
		? error.name === "AbortError"
		: error instanceof Error && error.name === "AbortError";
}

function sliceThroughHead(html: string) {
	const headEnd = html.search(/<\/head\s*>/i);
	return headEnd >= 0 ? html.slice(0, headEnd + 7) : html;
}

function hasHeadClose(html: string) {
	return /<\/head\s*>/i.test(html);
}

function truncate(value: string, maxLength: number) {
	return value.length > maxLength
		? `${value.slice(0, maxLength - 3)}...`
		: value;
}
