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
				: "Your response has been recorded.",
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
