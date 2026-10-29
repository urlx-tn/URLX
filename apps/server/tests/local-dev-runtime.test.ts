import { afterEach, describe, expect, it } from "vitest";
import { createLocalDevRuntime } from "../src/runtime/local-dev-runtime";

const originalNodeEnv = process.env.NODE_ENV;
const originalPreview = process.env.URLX_LOCAL_PREVIEW;

function runtime(now: { value: number }) {
	process.env.NODE_ENV = "development";
	process.env.URLX_LOCAL_PREVIEW = "true";
	return createLocalDevRuntime(
		"local-preview-test-key-material-32-bytes",
		() => now.value,
	);
}

afterEach(() => {
	if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = originalNodeEnv;
	if (originalPreview === undefined) delete process.env.URLX_LOCAL_PREVIEW;
	else process.env.URLX_LOCAL_PREVIEW = originalPreview;
});

describe("native local development state", () => {
	it("refuses implicit and production runtime selection", () => {
		process.env.NODE_ENV = "production";
		process.env.URLX_LOCAL_PREVIEW = "true";
		expect(() => createLocalDevRuntime("x".repeat(32))).toThrow(
			/development preview/,
		);
		process.env.NODE_ENV = "development";
		delete process.env.URLX_LOCAL_PREVIEW;
		expect(() => createLocalDevRuntime("x".repeat(32))).toThrow(
			/development preview/,
		);
	});

	it("expires auth entries and atomically consumes a one-time value", async () => {
		const now = { value: 10_000 };
		const { authStorage } = runtime(now);
		await authStorage.set("magic", "token", 2);
		expect(await authStorage.get("magic")).toBe("token");
		const consumed = await Promise.all([
			authStorage.getAndDelete("magic"),
			authStorage.getAndDelete("magic"),
		]);
		expect(consumed.filter(Boolean)).toEqual(["token"]);
		await authStorage.set("expires", "short-lived", 1);
		now.value += 1_001;
		expect(await authStorage.get("expires")).toBeNull();
	});

	it("increments counters atomically and retains the first TTL", async () => {
		const now = { value: 20_000 };
		const { authStorage } = runtime(now);
		const values = await Promise.all(
			Array.from({ length: 100 }, () => authStorage.increment("attempt", 2)),
		);
		expect(Math.max(...values)).toBe(100);
		expect(new Set(values).size).toBe(100);
		now.value += 1_500;
		await authStorage.increment("attempt", 20);
		now.value += 600;
		expect(await authStorage.get("attempt")).toBeNull();
	});

	it("enforces per-key fixed windows and resets at the next boundary", async () => {
		const now = { value: 59_999 };
		const { limiters } = runtime(now);
		const first = limiters.formsSubmit;
		const results = await Promise.all(
			Array.from({ length: 12 }, () => first.limit({ key: "visitor-a" })),
		);
		expect(results.filter((result) => result.success)).toHaveLength(10);
		expect((await first.limit({ key: "visitor-b" })).success).toBe(true);
		now.value = 60_000;
		expect((await first.limit({ key: "visitor-a" })).success).toBe(true);
	});
});
