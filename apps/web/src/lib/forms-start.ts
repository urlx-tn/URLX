import { formsRequest } from "./forms-api";
import { errorMessage, showToast } from "./forms-dialog";

/** Create a form from a starter template and open it in the editor. */
export async function startFromTemplate(
	template: string,
	button: HTMLButtonElement,
) {
	button.disabled = true;
	button.setAttribute("aria-busy", "true");
	try {
		const result = await formsRequest<{ form: { id: string } }>("", {
			method: "POST",
			body: JSON.stringify({ template, title: "" }),
		});
		window.location.assign(`/forms/${encodeURIComponent(result.form.id)}`);
	} catch (error) {
		if ((error as { status?: number })?.status === 401) {
			window.location.assign(
				`/forms?signin=1&template=${encodeURIComponent(template)}`,
			);
			return;
		}
		showToast(
			errorMessage(error, "Could not create your form. Please try again."),
			{ tone: "error" },
		);
		button.disabled = false;
		button.removeAttribute("aria-busy");
	}
}
