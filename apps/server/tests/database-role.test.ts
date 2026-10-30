import { describe, expect, it, vi } from "vitest";
import { assertApiDatabaseRole } from "../src/runtime/database-role";

function appIdentity(overrides: Record<string, unknown> = {}) {
	return {
		role: "urlx_app",
		sessionRole: "urlx_app",
		superuser: false,
		createRole: false,
		createDatabase: false,
		replication: false,
		bypassRls: false,
		canCreateDatabase: false,
		canCreatePublicSchema: false,
		...overrides,
	};
}

describe("API PostgreSQL role gate", () => {
	it("accepts only the live restricted app session and checks effective CREATE privileges", async () => {
		const query = vi.fn(async (_sql: string) => ({ rows: [appIdentity()] }));
		await expect(
			assertApiDatabaseRole({ query } as never),
		).resolves.toBeUndefined();
		expect(query).toHaveBeenCalledOnce();
		expect(query.mock.calls[0]?.[0]).toContain('session_user AS "sessionRole"');
		expect(query.mock.calls[0]?.[0]).toContain("has_database_privilege");
		expect(query.mock.calls[0]?.[0]).toContain("has_schema_privilege");
	});

	it.each([
		{ role: "urlx_migrator" },
		{ sessionRole: "urlx_bootstrap" },
		{ superuser: true },
		{ createRole: true },
		{ createDatabase: true },
		{ replication: true },
		{ bypassRls: true },
		{ canCreateDatabase: true },
		{ canCreatePublicSchema: true },
	])("rejects unsafe live identity: $role", async (override) => {
		const query = vi.fn(async (_sql: string) => ({
			rows: [appIdentity(override)],
		}));
		await expect(assertApiDatabaseRole({ query } as never)).rejects.toThrow(
			"API startup requires the restricted urlx_app database role",
		);
	});

	it("does not expose private SQL or connection details when the identity query fails", async () => {
		const query = vi.fn(async () => {
			throw new Error("password=private-pg-secret; SQL SELECT private_answer");
		});
		await expect(assertApiDatabaseRole({ query } as never)).rejects.toThrow(
			"API startup requires the restricted urlx_app database role",
		);
	});
});
