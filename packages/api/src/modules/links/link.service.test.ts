import { describe, expect, it, vi } from "vitest";
import { LinkService } from "./link.service";

function createService() {
	const repository = {
		findByUrlHash: vi.fn(async () => undefined),
		create: vi.fn(async (_link: { originalUrl: string }) => undefined),
	};
	const service = new LinkService({
		db: {} as never,
		shortUrlBase: "https://short.example.invalid",
		repository: repository as never,
	});
	return { repository, service };
}

describe("LinkService PostgreSQL text inputs", () => {
	it("rejects NUL before repository access", async () => {
		const { repository, service } = createService();

		await expect(
			service.shorten("https://example.com/a\0b"),
		).rejects.toMatchObject({
			code: "INVALID_URL",
			status: 400,
		});
		expect(repository.findByUrlHash).not.toHaveBeenCalled();
		expect(repository.create).not.toHaveBeenCalled();
	});

	it("continues to accept a percent-escaped NUL URL", async () => {
		const { repository, service } = createService();
		const rawUrl = "https://example.com/a%00b";

		await service.shorten(rawUrl);

		expect(repository.create).toHaveBeenCalledOnce();
		expect(repository.create.mock.calls[0]?.[0]).toMatchObject({
			originalUrl: rawUrl,
		});
	});

	it("continues to reject private destinations before repository access", async () => {
		const { repository, service } = createService();

		await expect(
			service.shorten("http://127.0.0.1:18080/f/test-form"),
		).rejects.toMatchObject({
			code: "PRIVATE_IP_NOT_ALLOWED",
			status: 400,
		});
		expect(repository.findByUrlHash).not.toHaveBeenCalled();
		expect(repository.create).not.toHaveBeenCalled();
	});
});
