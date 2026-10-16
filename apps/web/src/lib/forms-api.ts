import type {
	FormAccentId,
	FormDefinitionDto,
	FormFieldDto,
} from "@urlx/api/modules/forms/forms.types";

export type FormField = FormFieldDto;
export type FormDraft = Omit<FormDefinitionDto, "confirmationMessage"> & {
	confirmationMessage?: FormDefinitionDto["confirmationMessage"];
	accent: FormAccentId;
};

export type FormRecord = {
	id: string;
	title: string;
	slug?: string | null;
	status?: string;
	responseCount?: number;
	updatedAt?: string | number;
	createdAt?: string | number;
	[key: string]: unknown;
};

const endpoint = (path: string) => `/api/forms${path}`;

export async function formsRequest<T>(
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const response = await fetch(endpoint(path), {
		...init,
		credentials: "same-origin",
		headers: {
			...(init.body ? { "content-type": "application/json" } : {}),
			...init.headers,
		},
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		const message =
			(data as { message?: string; error?: string }).message ||
			(data as { error?: string }).error;
		const error = new Error(message || `Request failed (${response.status})`);
		Object.assign(error, { status: response.status, data });
		throw error;
	}
	return data as T;
}

export async function requestFormsSignIn(
	email: string,
	callbackURL = "/forms",
) {
	const response = await fetch("/api/auth/sign-in/magic-link", {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, callbackURL }),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok || (data as { status?: boolean }).status === false) {
		throw new Error(
			(data as { message?: string; error?: string }).message ||
				(data as { error?: string }).error ||
				"Could not send your sign-in link.",
		);
	}
	return data;
}

export function normalizeDraft(
	input: unknown,
	fallbackTitle = "Untitled form",
): FormDraft {
	const candidate = (input && typeof input === "object" ? input : {}) as Record<
		string,
		unknown
	>;
	const draft = (
		candidate.draft && typeof candidate.draft === "object"
			? candidate.draft
			: candidate
	) as Record<string, unknown>;
	const fields = Array.isArray(draft.fields) ? draft.fields : [];
	return {
		title: typeof draft.title === "string" ? draft.title : fallbackTitle,
		description: typeof draft.description === "string" ? draft.description : "",
		accent: (typeof draft.accent === "string"
			? draft.accent
			: "blue") as FormAccentId,
		confirmationMessage:
			typeof draft.confirmationMessage === "string"
				? draft.confirmationMessage
				: "Thank you for your response.",
		fields: fields.map((value, index) => {
			const field = (value && typeof value === "object" ? value : {}) as Record<
				string,
				unknown
			>;
			return {
				id: typeof field.id === "string" ? field.id : `field-${index + 1}`,
				type:
					typeof field.type === "string"
						? (field.type as FormField["type"])
						: "short",
				label: typeof field.label === "string" ? field.label : "Question",
				help: typeof field.help === "string" ? field.help : "",
				required: Boolean(field.required),
				options: Array.isArray(field.options) ? field.options.map(String) : [],
			};
		}),
	};
}

export const FORM_TEMPLATES: Record<
	string,
	{ title: string; draft: FormDraft }
> = {
	blank: {
		title: "Blank form",
		draft: {
			title: "Untitled form",
			description: "",
			accent: "blue",
			fields: [
				{
					id: crypto.randomUUID(),
					type: "short",
					label: "Question",
					required: false,
					options: [],
				},
			],
		},
	},
	contact: {
		title: "Contact",
		draft: {
			title: "Get in touch",
			description: "We usually reply within two working days.",
			accent: "teal",
			fields: [
				{
					id: crypto.randomUUID(),
					type: "short",
					label: "Your name",
					required: true,
					options: [],
				},
				{
					id: crypto.randomUUID(),
					type: "email",
					label: "Email",
					required: true,
					options: [],
				},
				{
					id: crypto.randomUUID(),
					type: "singlechoice",
					label: "What is it about?",
					required: false,
					options: [
						"A question",
						"Working together",
						"Press",
						"Something else",
					],
				},
				{
					id: crypto.randomUUID(),
					type: "paragraph",
					label: "Message",
					required: true,
					options: [],
				},
			],
		},
	},
	registration: {
		title: "Registration",
		draft: {
			title: "Workshop registration",
			description: "Share a few details to reserve your place.",
			accent: "blue",
			fields: [
				{
					id: crypto.randomUUID(),
					type: "short",
					label: "Full name",
					required: true,
					options: [],
				},
				{
					id: crypto.randomUUID(),
					type: "email",
					label: "Email",
					required: true,
					options: [],
				},
				{
					id: crypto.randomUUID(),
					type: "phone",
					label: "Phone",
					required: false,
					options: [],
				},
				{
					id: crypto.randomUUID(),
					type: "singlechoice",
					label: "Which session?",
					required: true,
					options: ["Morning", "Afternoon"],
				},
				{
					id: crypto.randomUUID(),
					type: "paragraph",
					label: "Anything we should know?",
					required: false,
					options: [],
				},
			],
		},
	},
	feedback: {
		title: "Feedback",
		draft: {
			title: "How was your experience?",
			description: "A few quick questions to help us improve.",
			accent: "orange",
			fields: [
				{
					id: crypto.randomUUID(),
					type: "rating",
					label: "How would you rate it overall?",
					required: true,
					options: [],
				},
				{
					id: crypto.randomUUID(),
					type: "multichoice",
					label: "What stood out?",
					required: false,
					options: ["Content", "People", "Venue", "Organization"],
				},
				{
					id: crypto.randomUUID(),
					type: "paragraph",
					label: "What could we improve?",
					required: false,
					options: [],
				},
			],
		},
	},
};
