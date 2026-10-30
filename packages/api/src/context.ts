import type { UrlxDb } from "@urlx/db";

import { verifyAnonymousVisitorToken } from "./lib/anonymous-visitor";
import { getTrustedClientIp } from "./lib/client-ip";
import type { RateLimiter, RateLimitIdentity } from "./lib/layered-rate-limit";
import type { MetadataFetcher } from "./modules/metadata/metadata.service";

export const defaultShortUrlBase = "http://localhost:4321";

type VisitorContext = {
	req: {
		header(name: string): string | undefined;
		header(): Record<string, string | undefined>;
	};
	env: { VISITOR_TOKEN_KEY: CryptoKey };
};

export type CreateContextOptions = {
	context: VisitorContext;
	db: UrlxDb;
	fetcher: MetadataFetcher;
	metadataIpRateLimiter: RateLimiter;
	metadataVisitorRateLimiter: RateLimiter;
	shortUrlBase?: string;
};

export async function createContext(options: CreateContextOptions) {
	const visitorTokenVerification = await verifyAnonymousVisitorToken(
		options.context.req.header("X-URLX-Visitor-Token"),
		options.context.env.VISITOR_TOKEN_KEY,
	);
	const rateLimitIdentity: RateLimitIdentity =
		visitorTokenVerification.status === "valid"
			? {
					kind: "visitor",
					visitorId: visitorTokenVerification.visitorId,
				}
			: { kind: "fallback-ip" };

	return {
		auth: null,
		clientIp: getTrustedClientIp(options.context.req.header()),
		db: options.db,
		fetcher: options.fetcher,
		metadataIpRateLimiter: options.metadataIpRateLimiter,
		metadataVisitorRateLimiter: options.metadataVisitorRateLimiter,
		now: () => new Date(),
		rateLimitIdentity,
		session: null,
		shortUrlBase: options.shortUrlBase ?? defaultShortUrlBase,
		visitorTokenVerification,
	};
}

export type Context = Awaited<ReturnType<typeof createContext>>;
