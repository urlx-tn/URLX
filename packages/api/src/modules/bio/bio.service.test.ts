import { describe, expect, it, vi } from "vitest";
import type { CreateBioInput } from "./bio.schema";
import { BioService } from "./bio.service";
import type { NewBioLink, NewBioPage } from "./bio.types";

const validInput = {
	title: "My page",
	description: "About me",
	slug: "valid-page",
	links: [{ label: "Website", url: "https://example.com" }],
};

const invalidInputs: Array<[string, CreateBioInput]> = [
	["title", { ...validInput, title: "My\0page" }],
	["description", { ...validInput, description: "About\0me" }],
	["slug", { ...validInput, slug: "valid\0page" }],
	[
		"link label",
		{
			...validInput,
			links: [{ label: "Web\0site", url: "https://example.com" }],
		},
	],
	[
		"link URL",
		{
			...validInput,
			links: [{ label: "Website", url: "https://example.com/\0" }],
		},
	],
];

describe("BioService PostgreSQL text inputs", () => {
	it("returns not found for a NUL slug without querying the repository", async () => {
		const findBySlug = vi.fn();
		const service = new BioService({
			db: {} as never,
			repository: { findBySlug } as never,
		});

		await expect(service.getBioPage("bad\0slug")).rejects.toMatchObject({
			code: "PAGE_NOT_FOUND",
			status: 404,
		});
		expect(findBySlug).not.toHaveBeenCalled();
	});

	it("rejects NUL in a public search query before repository access", async () => {
		const searchPages = vi.fn();
		const service = new BioService({
			db: {} as never,
			repository: { searchPages } as never,
		});

		await expect(
			service.searchBioPages({ query: "bad\0query" }),
		).rejects.toMatchObject({
			code: "INVALID_TEXT",
			status: 400,
		});
		expect(searchPages).not.toHaveBeenCalled();
	});

	it.each(invalidInputs)(
		"rejects NUL in %s before repository writes",
		async (_name, input) => {
			const createPageWithLinks = vi.fn();
			const service = new BioService({
				db: {} as never,
				repository: { createPageWithLinks } as never,
			});

			await expect(service.createBioPage(input)).rejects.toMatchObject({
				code: "INVALID_TEXT",
				status: 400,
			});
			expect(createPageWithLinks).not.toHaveBeenCalled();
		},
	);

	it("preserves percent-encoded NUL in a link URL", async () => {
		const capturedLinkRows: NewBioLink[][] = [];
		const createPageWithLinks = vi.fn(
			async (_page: NewBioPage, links: NewBioLink[]) => {
				capturedLinkRows.push(links);
			},
		);
		const service = new BioService({
			db: {} as never,
			repository: {
				slugExists: vi.fn(async () => false),
				createPageWithLinks,
			} as never,
		});
		const rawUrl = "https://example.com/%00";

		await expect(
			service.createBioPage({
				...validInput,
				links: [{ label: "Website", url: rawUrl }],
			}),
		).resolves.toEqual({ slug: "valid-page" });
		expect(capturedLinkRows[0]?.[0]?.url).toBe(rawUrl);
	});
});

describe("BioService search pagination", () => {
	it("preserves last-page metadata for an out-of-range request", async () => {
		const searchPages = vi.fn(async () => ({
			total: 100,
			items: [
				{
					slug: "last-page",
					title: "Last page",
					description: null,
					createdAt: 1,
				},
			],
		}));
		const service = new BioService({
			db: {} as never,
			repository: { searchPages } as never,
		});

		await expect(
			service.searchBioPages({
				query: "page",
				page: Number.MAX_SAFE_INTEGER,
				pageSize: 24,
			}),
		).resolves.toEqual({
			query: "page",
			page: 5,
			pageSize: 24,
			totalItems: 100,
			totalPages: 5,
			items: [
				{
					slug: "last-page",
					title: "Last page",
					description: null,
					createdAt: 1,
				},
			],
		});
		expect(searchPages).toHaveBeenCalledTimes(1);
		expect(searchPages).toHaveBeenCalledWith({
			query: "page",
			limit: 24,
			page: Number.MAX_SAFE_INTEGER,
		});
	});
});
