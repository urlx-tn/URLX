import { describe, expect, it } from "vitest";

import { RateLimitUnavailableError } from "../../lib/layered-rate-limit";
import { MetadataError, toMetadataError } from "./metadata.errors";

describe("toMetadataError", () => {
	it("maps limiter backend failures to a generic 503", () => {
		const result = toMetadataError(new RateLimitUnavailableError());

		expect(result).toEqual(new MetadataError("RATE_LIMIT_UNAVAILABLE"));
		expect(result.status).toBe(503);
		expect(result.message).not.toContain("private backend detail");
	});
});
