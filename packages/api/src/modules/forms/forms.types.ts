/** Stable Form DTOs shared by the browser editor, public renderer, and API. */
export const formFieldTypes = [
	"short",
	"paragraph",
	"email",
	"phone",
	"number",
	"singlechoice",
	"multichoice",
	"date",
	"rating",
] as const;

export type FormFieldType = (typeof formFieldTypes)[number];

export const formAccentIds = [
	"blue",
	"teal",
	"green",
	"orange",
	"pink",
	"graphite",
] as const;
export type FormAccentId = (typeof formAccentIds)[number];

export type FormFieldDto = {
	id: string;
	type: FormFieldType;
	label: string;
	help?: string;
	required: boolean;
	options?: string[];
};

export type FormDefinitionDto = {
	title: string;
	description?: string;
	accent: FormAccentId;
	confirmationMessage?: string;
	fields: FormFieldDto[];
};

export type FormAnswerValue = string | string[] | number;
export type FormAnswersDto = Record<string, FormAnswerValue>;
