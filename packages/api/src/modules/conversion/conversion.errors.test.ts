import { describe, expect, it } from "vitest";

import { RateLimitUnavailableError } from "../../lib/layered-rate-limit";
import { ConversionError, toConversionError } from "./conversion.errors";

describe("toConversionError", () => {
	it("maps limiter backend failures to a generic 503", () => {
		const result = toConversionError(new RateLimitUnavailableError());

		expect(result).toEqual(new ConversionError("RATE_LIMIT_UNAVAILABLE"));
		expect(result.status).toBe(503);
		expect(result.message).not.toContain("private backend detail");
	});
});
