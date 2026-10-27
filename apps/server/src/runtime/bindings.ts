import type { RateLimiter } from "@urlx/api/lib/layered-rate-limit";
import type { ConversionRenderer } from "@urlx/api/modules/conversion/conversion.service";
import type {
	FormsAuthEnv,
	FormsAuthSecondaryStorage,
} from "@urlx/api/modules/forms/auth";
import type { MetadataFetcher } from "@urlx/api/modules/metadata/metadata.service";
import type { UrlxDb } from "@urlx/db";

export type ApiAppBindings = FormsAuthEnv & {
	DB: UrlxDb;
	AUTH_SECONDARY_STORAGE: FormsAuthSecondaryStorage;
	VISITOR_TOKEN_KEY: CryptoKey;
	CORS_ORIGIN: string;
	SHORT_URL_BASE?: string;
	METADATA_FETCHER: MetadataFetcher;
	METADATA_IP_RATE_LIMIT: RateLimiter;
	METADATA_VISITOR_RATE_LIMIT: RateLimiter;
	FORMS_RENDER_RATE_LIMIT: RateLimiter;
	FORMS_SUBMIT_RATE_LIMIT: RateLimiter;
};

export type ConversionAppBindings = {
	BROWSER_RENDERER: ConversionRenderer;
	CONVERSION_IP_RATE_LIMIT: RateLimiter;
	CONVERSION_VISITOR_RATE_LIMIT: RateLimiter;
	CORS_ORIGIN: string;
	VISITOR_TOKEN_KEY: CryptoKey;
};
