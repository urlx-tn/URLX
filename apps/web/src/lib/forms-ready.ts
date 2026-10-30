/** Forms are enabled only when the deployment has provisioned their services. */
export function formsReady(value: string | boolean | undefined) {
	return value === true || String(value ?? "").toLowerCase() === "true";
}
