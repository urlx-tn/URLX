type FormsRuntimeConfig = {
	FORMS_ENABLED?: boolean | string;
};

/** Alchemy sets this server-side only when all private auth and email bindings are configured. */
export function formsReady(env: FormsRuntimeConfig) {
	return (
		env.FORMS_ENABLED === true ||
		String(env.FORMS_ENABLED ?? "").toLowerCase() === "true"
	);
}
