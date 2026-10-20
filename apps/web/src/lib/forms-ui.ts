import type {
	FormAccentId,
	FormFieldType,
} from "@urlx/api/modules/forms/forms.types";

/** Inline SVG icons for the Forms UI. Paths use a 24px grid and currentColor. */
const paths = {
	short: '<path d="M4 9.5h16M4 14.5h9"/>',
	paragraph: '<path d="M4 6h16M4 10h16M4 14h16M4 18h10"/>',
	email:
		'<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7.5 8 5.5 8-5.5"/>',
	phone:
		'<path d="M7 3.5h2.4l1.5 4.2-2.1 1.4a11.5 11.5 0 0 0 6.1 6.1l1.4-2.1 4.2 1.5V17a2.5 2.5 0 0 1-2.5 2.5A15 15 0 0 1 4.5 6 2.5 2.5 0 0 1 7 3.5Z"/>',
	number: '<path d="M9.5 4 8 20M16 4l-1.5 16M4.5 9h15M4 15h15"/>',
	singlechoice:
		'<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/>',
	multichoice:
		'<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="m8 12.2 2.8 2.8L16.2 9"/>',
	date: '<rect x="3.5" y="5" width="17" height="15.5" rx="3.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
	rating:
		'<path d="m12 3.6 2.55 5.17 5.7.83-4.12 4.02.97 5.68L12 16.62 6.9 19.3l.97-5.68L3.75 9.6l5.7-.83Z"/>',
	back: '<path d="M15 5l-7 7 7 7"/>',
	undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
	redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
	eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
	send: '<path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5Z"/>',
	up: '<path d="m6 15 6-6 6 6"/>',
	down: '<path d="m6 9 6 6 6-6"/>',
	copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
	trash:
		'<path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 0 0 2 1.8h7a2 2 0 0 0 2-1.8l1-12M9 7V4.5h6V7"/>',
	plus: '<path d="M12 5v14M5 12h14"/>',
	close: '<path d="M6 6l12 12M18 6 6 18"/>',
	link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4L11.5 6"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.5-1.4"/>',
	external:
		'<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
	download: '<path d="M12 4v11M7 10.5l5 5 5-5M4.5 19.5h15"/>',
	print:
		'<path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14h10v6.5H7Z"/>',
	inbox:
		'<path d="M3.5 13.5 6 5.5h12l2.5 8V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/><path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5"/>',
	clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
	check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
	palette:
		'<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.9 1.8-1.8 0-1.3-1-1.5-1-2.6 0-.9.7-1.6 1.6-1.6h2.1a4 4 0 0 0 4-4C20.5 6.6 16.7 3.5 12 3.5Z"/><circle cx="7.5" cy="11.5" r="1.2" fill="currentColor"/><circle cx="10" cy="7.5" r="1.2" fill="currentColor"/><circle cx="14.5" cy="7.5" r="1.2" fill="currentColor"/>',
	keyboard:
		'<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h1M10 10h1M13.5 10h1M17 10h.5M7.5 14h9"/>',
	ticket:
		'<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v2a2.5 2.5 0 0 0 0 5v2a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5v-2a2.5 2.5 0 0 0 0-5Z"/><path d="M14 6v12" stroke-dasharray="2 2.5"/>',
	briefcase:
		'<rect x="3.5" y="7" width="17" height="12.5" rx="2.5"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12.5h17"/>',
	bag: '<path d="M5 8h14l-1 11.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19.5Z"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/>',
	smile:
		'<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01" stroke-width="2.6"/>',
	chat: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 16V7A1.5 1.5 0 0 1 5 5.5Z"/>',
	megaphone:
		'<path d="M4 10v4a1 1 0 0 0 1 1h2l8 4.5v-15L7 9H5a1 1 0 0 0-1 1Z"/><path d="M18 9.5a3.5 3.5 0 0 1 0 5M8 15l1 4.5"/>',
	list: '<path d="M9 7h11M9 12h11M9 17h11"/><path d="M4.5 7h.01M4.5 12h.01M4.5 17h.01" stroke-width="2.6"/>',
	forms:
		'<rect x="5" y="3" width="14" height="18" rx="3.5"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>',
} as const;

export type FormsIconName = keyof typeof paths;

export function formsIcon(name: FormsIconName, size = 18) {
	return `<svg class="f-ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}

export const fieldTypeOrder: FormFieldType[] = [
	"short",
	"paragraph",
	"email",
	"phone",
	"number",
	"date",
	"singlechoice",
	"multichoice",
	"rating",
];

/** Display metadata per field type. Types are told apart by icon, not colour. */
export const fieldTypeMeta: Record<
	FormFieldType,
	{ name: string; hint: string; group: string }
> = {
	short: {
		name: "Short answer",
		hint: "Single line",
		group: "Text",
	},
	paragraph: {
		name: "Paragraph",
		hint: "Multi-line text",
		group: "Text",
	},
	email: {
		name: "Email",
		hint: "Checked address",
		group: "Contact",
	},
	phone: {
		name: "Phone",
		hint: "Number keypad",
		group: "Contact",
	},
	number: {
		name: "Number",
		hint: "Digits only",
		group: "Data",
	},
	date: {
		name: "Date",
		hint: "Date picker",
		group: "Data",
	},
	singlechoice: {
		name: "One choice",
		hint: "Pick one",
		group: "Choice",
	},
	multichoice: {
		name: "Several choices",
		hint: "Pick several",
		group: "Choice",
	},
	rating: {
		name: "Rating",
		hint: "1 to 5 stars",
		group: "Choice",
	},
};

export const accentColors: Record<FormAccentId, string> = {
	blue: "#0071e3",
	teal: "#0e7c86",
	green: "#248a3d",
	orange: "#c2410c",
	pink: "#c2185b",
	graphite: "#48484a",
};

const templatePreviewFieldScore: Record<string, number> = {
	singlechoice: 5,
	multichoice: 5,
	rating: 5,
	date: 4,
	paragraph: 4,
	number: 3,
	short: 1,
	email: 1,
	phone: 1,
};

function templatePreviewFields(fields: PublicField[]) {
	if (fields.length <= 2) return fields;

	// Prefer two characteristic questions. If a template has only one, pair it
	// with a familiar identity question so the preview still reads as a form.
	const primaryIndex = fields.findIndex((field) =>
		["short", "email", "phone"].includes(field.type ?? ""),
	);
	const distinctive = fields
		.map((field, index) => ({
			index,
			score: templatePreviewFieldScore[field.type ?? ""] ?? 0,
		}))
		.filter(({ score }) => score >= 3)
		.sort((a, b) => b.score - a.score || a.index - b.index);
	const selected = distinctive.slice(0, 2).map(({ index }) => index);
	if (
		selected.length < 2 &&
		primaryIndex >= 0 &&
		!selected.includes(primaryIndex)
	)
		selected.push(primaryIndex);

	for (let index = 0; selected.length < 2 && index < fields.length; index++) {
		if (!selected.includes(index)) selected.push(index);
	}

	return selected.sort((a, b) => a - b).map((index) => fields[index]);
}

function templatePreviewControl(field: PublicField) {
	if (field.type === "rating")
		return '<span class="f-template-mini-stars">★★★★★</span>';
	if (field.type === "singlechoice" || field.type === "multichoice") {
		const options = Array.isArray(field.options)
			? field.options.slice(0, 2)
			: [];
		const kind = field.type === "multichoice" ? "checkboxes" : "radios";
		return `<span class="f-template-mini-options ${kind}">${options
			.map((option) => `<span>${escapeHtml(option)}</span>`)
			.join("")}</span>`;
	}
	if (field.type === "paragraph")
		return '<span class="f-template-mini-lines"><i></i><i></i></span>';
	if (field.type === "date")
		return '<span class="f-template-mini-input date"><i></i></span>';
	return '<span class="f-template-mini-input"></span>';
}

/** Small decorative form preview for the template gallery cards. */
export function templatePreviewMarkup(draft: {
	title?: string;
	accent?: string;
	fields: PublicField[];
}) {
	const accent =
		accentColors[(draft.accent ?? "blue") as FormAccentId] ?? accentColors.blue;
	const fields = templatePreviewFields(draft.fields);
	return `<div class="f-template-preview" style="--f-template-accent:${accent}" aria-hidden="true"><div class="f-template-mini-top"><span></span><span></span><span></span></div><p class="f-template-preview-title">${escapeHtml(draft.title || "Untitled form")}</p><div class="f-template-mini-fields">${fields
		.map(
			(field) =>
				`<div class="f-template-mini-field"><span class="f-template-mini-label">${escapeHtml(field.label || "Question")}</span>${templatePreviewControl(field)}</div>`,
		)
		.join("")}</div></div>`;
}

const escapeHtml = (value: unknown) =>
	String(value ?? "").replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			] ?? c,
	);

const starPath = paths.rating;

/**
 * Five star radios for a rating question. Inputs come in reverse order so the
 * `input:checked ~ label` rule fills every star up to the chosen one.
 */
export function ratingMarkup(name: string, idBase: string, required: boolean) {
	return `<div class="f-stars">${[5, 4, 3, 2, 1]
		.map(
			(n) =>
				`<input type="radio" id="${escapeHtml(idBase)}-${n}" name="${escapeHtml(name)}" value="${n}" ${required && n === 1 ? "required" : ""}><label for="${escapeHtml(idBase)}-${n}" title="${n} of 5"><span class="f-sr">${n} star${n === 1 ? "" : "s"}</span><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${starPath}</svg></label>`,
		)
		.join("")}</div>`;
}

type PublicField = {
	id?: string;
	type?: string;
	label?: string;
	help?: string;
	required?: boolean;
	options?: string[];
};

const inputTypes: Record<string, string> = {
	email: "email",
	phone: "tel",
	number: "number",
	date: "date",
};
const placeholders: Record<string, string> = {
	short: "Your answer",
	paragraph: "Your answer",
	email: "name@example.com",
	phone: "+1 555 010 0000",
	number: "0",
};

/**
 * One respondent-facing question. Shared by the public page, the editor
 * preview and the template preview so all three always look the same.
 * `idPrefix` keeps ids unique when several forms render on one page.
 */
export function publicFieldMarkup(
	field: PublicField,
	index: number,
	idPrefix = "",
) {
	const rawId = String(field.id || `question-${index + 1}`);
	const id = `${idPrefix}${rawId}`;
	const label = escapeHtml(field.label || `Question ${index + 1}`);
	const required = Boolean(field.required);
	const help = field.help
		? `<p class="help" id="${escapeHtml(id)}-help">${escapeHtml(field.help)}</p>`
		: "";
	const described = field.help
		? `aria-describedby="${escapeHtml(id)}-help"`
		: "";
	const name = `answers[${rawId}]`;
	const mark = required
		? ' <span class="f-req" aria-hidden="true">*</span>'
		: "";
	if (field.type === "singlechoice" || field.type === "multichoice") {
		const multi = field.type === "multichoice";
		const options = Array.isArray(field.options) ? field.options : [];
		return `<div class="f-public-field"><fieldset ${described}><legend>${label}${mark}</legend>${help}${multi ? '<p class="help">Select all that apply.</p>' : ""}<div class="f-choices">${options
			.map(
				(option, i) =>
					`<label class="choice"><input type="${multi ? "checkbox" : "radio"}" name="${escapeHtml(name)}${multi ? "[]" : ""}" value="${escapeHtml(option)}" ${required && !multi && i === 0 ? "required" : ""}><span>${escapeHtml(option)}</span></label>`,
			)
			.join("")}</div></fieldset></div>`;
	}
	if (field.type === "rating")
		return `<div class="f-public-field"><fieldset ${described}><legend>${label}${mark}</legend>${help}${ratingMarkup(name, id, required)}</fieldset></div>`;
	const common = `name="${escapeHtml(name)}" id="${escapeHtml(id)}" ${required ? "required" : ""} ${described} placeholder="${placeholders[field.type ?? ""] ?? ""}"`;
	const input =
		field.type === "paragraph"
			? `<textarea class="f-textarea" ${common} rows="4"></textarea>`
			: `<input class="f-input" ${common} type="${inputTypes[field.type ?? ""] ?? "text"}" ${field.type === "phone" ? 'inputmode="tel" autocomplete="tel"' : field.type === "email" ? 'autocomplete="email"' : ""}>`;
	return `<div class="f-public-field"><label for="${escapeHtml(id)}">${label}${mark}</label>${help}${input}</div>`;
}

/** A complete, non-submitting form card for previews. */
export function previewFormMarkup(
	draft: {
		title?: string;
		description?: string;
		accent?: string;
		fields: PublicField[];
	},
	idPrefix: string,
) {
	const accent =
		accentColors[(draft.accent ?? "blue") as FormAccentId] ?? accentColors.blue;
	const hasRequired = draft.fields.some((field) => field.required);
	return `<div class="f-public-card" style="--form-accent:${accent}"><div class="f-band"></div><header class="f-public-head"><h1>${escapeHtml(draft.title || "Untitled form")}</h1>${draft.description ? `<p>${escapeHtml(draft.description)}</p>` : ""}${hasRequired ? '<p class="f-required-note"><span class="f-req">*</span> Required</p>' : ""}</header><div class="f-public-fields">${draft.fields.map((field, index) => publicFieldMarkup(field, index, idPrefix)).join("")}</div><div class="f-public-footer"><button class="f-btn" type="button">Submit</button></div></div>`;
}
