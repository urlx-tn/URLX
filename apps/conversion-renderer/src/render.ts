import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
	type Request,
	type Route,
} from "playwright";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { isUnsafeRequestUrl } from "./network-safety";

export { isUnsafeRequestUrl } from "./network-safety";

export type RenderFormat = "html" | "markdown";

export class RendererError extends Error {
	constructor(
		readonly code:
			| "INVALID_URL"
			| "PAGE_FETCH_FAILED"
			| "HTML_TOO_LARGE"
			| "MARKDOWN_TOO_LARGE",
		message = code,
	) {
		super(message);
		this.name = "RendererError";
	}
}

export type RendererOptions = {
	proxyUrl: string;
	concurrency: number;
	maxQueue: number;
	queueTimeoutMs: number;
};

export type RenderInput = {
	url: string;
	format: RenderFormat;
};

const maxTrackedRequests = 128;
const maxResponseBytes = 4 * 1024 * 1024;
const maxTransferredBytes = 16 * 1024 * 1024;

const limits: Record<
	RenderFormat,
	{
		maxLength: number;
		waitUntil: "domcontentloaded" | "networkidle2";
		blockedTypes: string[];
	}
> = {
	markdown: {
		maxLength: 1_000_000,
		waitUntil: "domcontentloaded",
		blockedTypes: ["image", "media", "font", "stylesheet"],
	},
	html: {
		maxLength: 2_000_000,
		waitUntil: "networkidle2",
		blockedTypes: ["image", "media", "font"],
	},
};

const maxMarkdownSourceLength = 4_000_000;
const htmlWaitQuietMs = 500;
const maxRequestUrlLength = 4_096;

export function requireRendererProxyUrl(raw: string | undefined): string {
	if (!raw) throw new Error("EGRESS_PROXY_URL is required");
	let proxy: URL;
	try {
		proxy = new URL(raw);
	} catch {
		throw new Error("EGRESS_PROXY_URL must be a valid URL");
	}
	if (
		proxy.protocol !== "http:" ||
		proxy.hostname !== "egress-proxy" ||
		proxy.port !== "3128" ||
		proxy.username ||
		proxy.password ||
		(proxy.pathname !== "/" && proxy.pathname !== "") ||
		proxy.search ||
		proxy.hash
	) {
		throw new Error("EGRESS_PROXY_URL must target http://egress-proxy:3128");
	}
	return proxy.origin;
}

export async function launchRenderer(options: RendererOptions) {
	const proxyUrl = requireRendererProxyUrl(options.proxyUrl);
	const browser = await chromium.launch({
		headless: true,
		chromiumSandbox: true,
		proxy: { server: proxyUrl, bypass: "" },
		args: [
			"--proxy-bypass-list=<-loopback>",
			"--disable-quic",
			"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
		],
	});
	return new PlaywrightRenderer(browser, options);
}

export class PlaywrightRenderer {
	private readonly queue: RenderQueue;

	constructor(
		private readonly browser: Browser,
		options: RendererOptions,
	) {
		this.queue = new RenderQueue(
			options.concurrency,
			options.maxQueue,
			options.queueTimeoutMs,
		);
	}

	async render(input: RenderInput): Promise<string> {
		const target = validateTargetUrl(input.url);
		const config = limits[input.format];
		const release = await this.queue.acquire();
		try {
			return await this.renderWithBrowser(target, input.format, config);
		} finally {
			release();
		}
	}

	async close() {
		await this.browser.close();
	}

	private async renderWithBrowser(
		target: URL,
		format: RenderFormat,
		config: (typeof limits)[RenderFormat],
	) {
		let context: BrowserContext | undefined;
		let closeNetworkTracker: () => void = () => {};
		let rejectResourceBudget: ((error: RendererError) => void) | undefined;
		const resourceBudgetExceeded = new Promise<never>((_resolve, reject) => {
			rejectResourceBudget = reject;
		});
		// The promise is raced below, so suppress its separate unhandled-rejection
		// report when a budget fires while setup is still in progress.
		void resourceBudgetExceeded.catch(() => undefined);
		const withinBudget = <T>(operation: Promise<T>) =>
			Promise.race([operation, resourceBudgetExceeded]);
		const hardTimeout = setTimeout(() => {
			rejectResourceBudget?.(new RendererError("PAGE_FETCH_FAILED"));
			void context?.close().catch(() => undefined);
		}, 30_000);
		try {
			context = await this.browser.newContext({ serviceWorkers: "block" });
			const budget = createResourceBudget(format, (error) => {
				rejectResourceBudget?.(error);
				void context?.close().catch(() => undefined);
			});
			await context.addInitScript(() => {
				for (const name of ["Worker", "SharedWorker", "EventSource"] as const) {
					Object.defineProperty(window, name, {
						configurable: false,
						writable: false,
						value: () => {
							throw new DOMException(
								"This browser feature is disabled during conversion",
								"NotSupportedError",
							);
						},
					});
				}
			});
			const page = await context.newPage();
			await context.route("**/*", (route) => {
				return guardRendererRoute(route, new Set(config.blockedTypes), {
					page,
				});
			});
			await context.routeWebSocket("**/*", (socket) =>
				socket.close({
					code: 1008,
					reason: "WebSockets disabled during conversion",
				}),
			);
			page.setDefaultNavigationTimeout(30_000);
			page.setDefaultTimeout(30_000);
			page.on("popup", (popup) => {
				void popup.close().catch(() => undefined);
			});
			const cdp = await context.newCDPSession(page);
			cdp.on("Fetch.requestPaused", (event: FetchRequestPaused) => {
				budget.requestStarted();
				const command = isUnsafeRequestUrl(event.request.url)
					? cdp.send("Fetch.failRequest", {
							requestId: event.requestId,
							errorReason: "BlockedByClient",
						})
					: cdp.send("Fetch.continueRequest", {
							requestId: event.requestId,
						});
				void command.catch(() => {
					rejectResourceBudget?.(new RendererError("PAGE_FETCH_FAILED"));
					void context?.close().catch(() => undefined);
				});
			});
			await cdp.send("Fetch.enable", {
				patterns: [{ urlPattern: "*", requestStage: "Request" }],
			});
			cdp.on("Network.responseReceived", (event) =>
				budget.responseReceived(event.requestId, event.response.headers),
			);
			cdp.on("Network.dataReceived", (event) =>
				budget.dataReceived(
					event.requestId,
					event.dataLength,
					event.encodedDataLength,
				),
			);
			await cdp.send("Network.enable", {
				maxTotalBufferSize: maxTransferredBytes,
				maxResourceBufferSize: maxResponseBytes,
			});
			await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
			const network = trackNetwork(page);
			closeNetworkTracker = network.close;
			const navigationStartedAt = Date.now();

			try {
				await withinBudget(
					page.goto(target.toString(), {
						waitUntil: "domcontentloaded",
						timeout: 30_000,
					}),
				);
			} catch (error) {
				if (error instanceof RendererError) throw error;
				if (!isNavigationTimeout(error) || page.url() === "about:blank")
					throw new RendererError("PAGE_FETCH_FAILED");
			}

			if (config.waitUntil === "networkidle2") {
				await withinBudget(
					network.wait(
						Math.max(0, 30_000 - (Date.now() - navigationStartedAt)),
					),
				);
			}

			if (format === "html") {
				const documentLength = await withinBudget(
					page.evaluate(() => document.documentElement?.outerHTML.length ?? 0),
				);
				if (documentLength > config.maxLength)
					throw new RendererError("HTML_TOO_LARGE");
				const html = await withinBudget(page.content());
				if (html.length > config.maxLength)
					throw new RendererError("HTML_TOO_LARGE");
				return html;
			}

			const bodyHtml = await withinBudget(
				page
					.locator("body")
					.evaluate((body) => (body as HTMLElement).innerHTML),
			);
			if (bodyHtml.length > maxMarkdownSourceLength)
				throw new RendererError("MARKDOWN_TOO_LARGE");
			const markdown = toMarkdown(bodyHtml);
			if (markdown.length > config.maxLength)
				throw new RendererError("MARKDOWN_TOO_LARGE");
			return markdown;
		} catch (error) {
			if (error instanceof RendererError) throw error;
			throw new RendererError("PAGE_FETCH_FAILED");
		} finally {
			clearTimeout(hardTimeout);
			closeNetworkTracker();
			await context?.close().catch(() => undefined);
		}
	}
}

export async function guardRendererRoute(
	route: Route,
	blockedTypes: Set<string>,
	options: { page?: Page } = {},
) {
	const request = route.request();
	const rawUrl = request.url();
	let isSubframe = false;
	try {
		isSubframe = !!options.page && request.frame() !== options.page.mainFrame();
	} catch {
		// Worker-originated requests are not required for HTML/Markdown output.
		isSubframe = true;
	}
	if (
		rawUrl.length > maxRequestUrlLength ||
		isSubframe ||
		blockedTypes.has(request.resourceType()) ||
		(request.headers?.().accept ?? "")
			.toLowerCase()
			.includes("text/event-stream") ||
		isUnsafeRequestUrl(rawUrl)
	) {
		await route.abort("blockedbyclient");
		return;
	}
	await route.continue();
}

type ResourceCounters = {
	encodedBytes: number;
	decodedBytes: number;
	countedBytes: number;
};

type FetchRequestPaused = {
	requestId: string;
	request: { url: string };
};

export function createResourceBudget(
	format: RenderFormat,
	onExceeded: (error: RendererError) => void,
) {
	const outputLimit = limits[format].maxLength;
	const failure = () =>
		onExceeded(
			new RendererError(
				format === "html" ? "HTML_TOO_LARGE" : "MARKDOWN_TOO_LARGE",
			),
		);
	const requests = new Map<string, ResourceCounters>();
	let requestCount = 0;
	let transferredBytes = 0;
	let exceeded = false;
	const exceed = () => {
		if (exceeded) return;
		exceeded = true;
		failure();
	};
	return {
		requestStarted() {
			requestCount += 1;
			if (requestCount > maxTrackedRequests) exceed();
		},
		responseReceived(requestId: string, headers: Record<string, unknown>) {
			const counter: ResourceCounters = {
				encodedBytes: 0,
				decodedBytes: 0,
				countedBytes: 0,
			};
			requests.set(requestId, counter);
			const contentLength = Object.entries(headers).find(
				([name]) => name.toLowerCase() === "content-length",
			)?.[1];
			if (typeof contentLength === "string") {
				const parsed = Number(contentLength);
				if (Number.isFinite(parsed) && parsed > maxResponseBytes) exceed();
			}
		},
		dataReceived(
			requestId: string,
			decodedDelta: number,
			encodedDelta: number,
		) {
			const counter = requests.get(requestId);
			if (!counter || exceeded) return;
			counter.decodedBytes += Math.max(0, decodedDelta);
			counter.encodedBytes += Math.max(0, encodedDelta);
			const nextCounted = Math.max(counter.decodedBytes, counter.encodedBytes);
			if (nextCounted > maxResponseBytes) {
				exceed();
				return;
			}
			transferredBytes += nextCounted - counter.countedBytes;
			counter.countedBytes = nextCounted;
			if (
				transferredBytes > maxTransferredBytes ||
				transferredBytes > outputLimit * 8
			)
				exceed();
		},
		get exceeded() {
			return exceeded;
		},
	};
}

function validateTargetUrl(rawUrl: string) {
	const value = rawUrl.trim();
	if (!value || value.length > 2_048) throw new RendererError("INVALID_URL");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new RendererError("INVALID_URL");
	}
	if (isUnsafeRequestUrl(url.toString()))
		throw new RendererError("INVALID_URL");
	if (url.username || url.password) throw new RendererError("INVALID_URL");
	return url;
}

export function toMarkdown(html: string) {
	const converter = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		strongDelimiter: "**",
		emDelimiter: "_",
	});
	converter.use(gfm);
	return converter.turndown(html).trim();
}

function trackNetwork(page: Page) {
	const requests = new Set<import("playwright").Request>();
	const onRequest = (request: Request) => requests.add(request);
	const onComplete = (request: Request) => requests.delete(request);
	page.on("request", onRequest);
	page.on("requestfinished", onComplete);
	page.on("requestfailed", onComplete);
	return {
		async wait(timeoutMs: number) {
			const start = Date.now();
			let idleSince: number | undefined;
			while (Date.now() - start < timeoutMs) {
				if (requests.size <= 2) {
					idleSince ??= Date.now();
					if (Date.now() - idleSince >= htmlWaitQuietMs) return;
				} else {
					idleSince = undefined;
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		},
		close() {
			page.off("request", onRequest);
			page.off("requestfinished", onComplete);
			page.off("requestfailed", onComplete);
		},
	};
}

function isNavigationTimeout(error: unknown) {
	return error instanceof Error && /timeout/i.test(error.message);
}

class RenderQueue {
	private active = 0;
	private readonly pending: Array<{
		resolve: (release: () => void) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}> = [];

	constructor(
		private readonly concurrency: number,
		private readonly maxQueue: number,
		private readonly timeoutMs: number,
	) {}

	acquire(): Promise<() => void> {
		if (this.active < this.concurrency) {
			this.active += 1;
			return Promise.resolve(() => this.release());
		}
		if (this.pending.length >= this.maxQueue)
			return Promise.reject(new Error("RENDERER_BUSY"));
		return new Promise((resolve, reject) => {
			const entry = {
				resolve,
				reject,
				timer: setTimeout(() => {
					const index = this.pending.indexOf(entry);
					if (index >= 0) this.pending.splice(index, 1);
					reject(new Error("RENDERER_BUSY"));
				}, this.timeoutMs),
			};
			this.pending.push(entry);
		});
	}

	private release() {
		const next = this.pending.shift();
		if (!next) {
			this.active = Math.max(0, this.active - 1);
			return;
		}
		clearTimeout(next.timer);
		next.resolve(() => this.release());
	}
}
