import { describe, expect, it } from "vitest";
import { validateDefinition } from "../src/modules/forms/forms.service";
import {
	formTemplateCategories,
	formTemplateDraft,
	formTemplates,
} from "../src/modules/forms/forms.templates";

describe("form templates", () => {
	it.each(formTemplates.map((template) => [template.id, template] as const))(
		"%s passes the same validation as a saved draft",
		(_id, template) => {
			expect(() => validateDefinition(template.draft)).not.toThrow();
		},
	);

	it("uses unique ids and known categories", () => {
		const ids = formTemplates.map((template) => template.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const template of formTemplates)
			expect([...formTemplateCategories, "Start"]).toContain(template.category);
	});

	it("falls back to the blank template and applies a custom title", () => {
		expect(formTemplateDraft("does-not-exist").title).toBe("Untitled form");
		expect(formTemplateDraft("contact", "  Say hello ").title).toBe(
			"Say hello",
		);
	});

	it("returns a copy, so edits never leak into the shared template", () => {
		const draft = formTemplateDraft("feedback");
		draft.fields.pop();
		expect(formTemplateDraft("feedback").fields).toHaveLength(
			formTemplates.find((template) => template.id === "feedback")?.draft.fields
				.length ?? 0,
		);
	});
});
