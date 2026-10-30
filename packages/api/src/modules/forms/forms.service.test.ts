import { describe, expect, it, vi } from "vitest";
import type { FormDefinition } from "./forms.service";
import { FormsError, FormsService, validateDefinition } from "./forms.service";

const definition: FormDefinition = {
	title: "Contact form",
	accent: "blue",
	fields: [{ id: "message", type: "short", label: "Message", required: false }],
};

describe("validateDefinition PostgreSQL text inputs", () => {
	it("returns not found for a NUL public slug without database access", async () => {
		const select = vi.fn();
		const service = new FormsService({ select } as never);

		await expect(service.getPublic("bad\0slug")).resolves.toBeNull();
		expect(select).not.toHaveBeenCalled();
	});

	it("returns not found for a NUL form ID without database access", async () => {
		const select = vi.fn();
		const service = new FormsService({ select } as never);

		await expect(service.get("owner", "bad\0id")).resolves.toBeNull();
		expect(select).not.toHaveBeenCalled();
		await expect(service.delete("owner", "bad\0id")).resolves.toBe(false);
		await expect(service.responses("owner", "bad\0id")).resolves.toBeNull();
		await expect(
			service.setSlug("owner", "bad\0id", "valid-slug"),
		).resolves.toBeNull();
		await expect(
			service.deleteResponse("owner", "bad\0id"),
		).resolves.toBeNull();
		await expect(
			service.exportRowsInPages("owner", "bad\0id"),
		).resolves.toBeNull();
		expect(select).not.toHaveBeenCalled();
	});

	it("returns not found for NUL response selectors before ownership lookup", async () => {
		const select = vi.fn();
		const service = new FormsService({ select } as never);

		await expect(
			service.deleteResponse("owner", "valid-form-id", "bad\0response"),
		).resolves.toBeNull();
		expect(select).not.toHaveBeenCalled();
	});

	it("rejects NUL in form search and decoded list cursor IDs", async () => {
		const select = vi.fn();
		const service = new FormsService({ select } as never);
		await expect(
			service.list("owner", { search: "bad\0search" }),
		).rejects.toMatchObject({ code: "INVALID_SEARCH", status: 400 });

		const cursor = btoa(
			JSON.stringify({ updatedAt: Date.now(), id: "bad\0id", search: "" }),
		)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/g, "");
		await expect(service.list("owner", { cursor })).rejects.toMatchObject({
			code: "INVALID_CURSOR",
			status: 400,
		});
		expect(select).not.toHaveBeenCalled();
	});

	it.each([
		["title", { title: "Contact\0form" }, "INVALID_TITLE"],
		["description", { description: "Details\0here" }, "INVALID_DESCRIPTION"],
		[
			"confirmation message",
			{ confirmationMessage: "Thanks\0!" },
			"INVALID_FORM",
		],
	] as const)(
		"rejects NUL in %s before persistence",
		(_name, override, code) => {
			try {
				validateDefinition({ ...definition, ...override });
				expect.fail("NUL-containing direct text must be rejected");
			} catch (error) {
				expect(error).toBeInstanceOf(FormsError);
				expect(error).toMatchObject({ code, status: 400 });
			}
		},
	);

	it("keeps NUL in JSON-only field content eligible for JSON text storage", () => {
		const result = validateDefinition({
			...definition,
			fields: [
				{
					id: "message",
					type: "short",
					label: "Message\0label",
					required: false,
				},
			],
		});

		expect(result.fields[0]?.label).toBe("Message\0label");
		expect(JSON.stringify(result.fields)).toContain("\\u0000");
	});

	it("rejects direct text before create reaches the database", async () => {
		const insert = vi.fn();
		const service = new FormsService({ insert } as never);

		await expect(
			service.create("owner", { ...definition, title: "Contact\0form" }),
		).rejects.toMatchObject({ code: "INVALID_TITLE", status: 400 });
		expect(insert).not.toHaveBeenCalled();
	});

	it("rejects NUL in a direct form slug before database access", async () => {
		const select = vi.fn();
		const service = new FormsService({ select } as never);

		await expect(
			service.setSlug("owner", "form-id", "bad\0slug"),
		).rejects.toMatchObject({
			code: "INVALID_SLUG",
			status: 400,
		});
		expect(select).not.toHaveBeenCalled();
	});
});
