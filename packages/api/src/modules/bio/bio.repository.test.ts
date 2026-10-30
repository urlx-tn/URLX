import { describe, expect, it, vi } from "vitest";
import type { UrlxDb } from "@urlx/db";
import { BioRepository } from "./bio.repository";

function createSearchDb(total: number) {
	const offsets: number[] = [];
	const db = {
		select: vi
			.fn()
			.mockImplementationOnce(() => createQuery([{ total }]))
			.mockImplementationOnce(() => createQuery([{ slug: "last-page" }])),
	};

	function createQuery<T>(result: T) {
		const query: Record<string, unknown> = {};
		for (const method of ["from", "where", "orderBy", "limit"]) {
			query[method] = vi.fn(() => query);
		}
		query.offset = vi.fn((offset: number) => {
			offsets.push(offset);
			return query;
		});
		query.then = (resolve: (value: T) => unknown) => resolve(result);
		return query;
	}

	return { db: db as unknown as UrlxDb, offsets, select: db.select };
}

describe("BioRepository search pagination", () => {
	it("clamps a huge requested page before building the SQL offset", async () => {
		const { db, offsets, select } = createSearchDb(100);
		const repository = new BioRepository(db);

		const result = await repository.searchPages({
			query: "",
			limit: 24,
			page: Number.MAX_SAFE_INTEGER,
		});

		expect(offsets).toEqual([96]);
		expect(select).toHaveBeenCalledTimes(2);
		expect(result).toEqual({ total: 100, items: [{ slug: "last-page" }] });
	});

	it("uses the first page for an empty result set", async () => {
		const { db, offsets, select } = createSearchDb(0);
		const repository = new BioRepository(db);

		const result = await repository.searchPages({
			query: "missing",
			limit: 8,
			page: Number.MAX_SAFE_INTEGER,
		});

		expect(offsets).toEqual([0]);
		expect(select).toHaveBeenCalledTimes(2);
		expect(result.total).toBe(0);
	});
});
