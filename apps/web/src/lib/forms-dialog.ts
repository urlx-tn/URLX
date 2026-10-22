import { formsIcon } from "./forms-ui";

/** In-app replacements for window.confirm/alert, styled to match URLX Forms. */

const host = () =>
	(document.querySelector(".forms-app") as HTMLElement | null) ?? document.body;

const escapeHtml = (value: unknown) =>
	String(value ?? "").replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			] ?? c,
	);

export type ConfirmOptions = {
	title: string;
	message?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	danger?: boolean;
};

export type RespondentAccessChoice = "public" | "verified_email";

/** Makes the respondent access decision part of every publish confirmation. */
export function chooseRespondentAccess(
	current?: RespondentAccessChoice | null,
): Promise<RespondentAccessChoice | null> {
	const dialog = document.createElement("dialog");
	dialog.className = "f-confirm f-publish-dialog";
	dialog.setAttribute("aria-labelledby", "f-publish-title");
	dialog.setAttribute(
		"aria-describedby",
		"f-publish-description f-publish-choice-hint",
	);
	dialog.innerHTML = `<div class="f-confirm-body"><h2 id="f-publish-title">Who can respond?</h2><p id="f-publish-description">Choose who can open this form after you publish.</p><fieldset class="f-access-options" aria-describedby="f-publish-choice-hint"><legend>Respondent access <span aria-hidden="true">*</span></legend><label class="f-access-option"><input type="radio" name="respondent-access" value="public" required ${current === "public" ? "checked" : ""}><span><strong>Anyone with the link</strong><small>No sign-in required.</small></span></label><label class="f-access-option"><input type="radio" name="respondent-access" value="verified_email" required ${current === "verified_email" ? "checked" : ""}><span><strong>Verified email required</strong><small>Respondents sign in with a one-time email link.</small></span></label></fieldset><p id="f-publish-choice-hint" class="f-access-note">${current ? "Current setting selected. You can change it here." : "Choose an option to continue."}</p><div class="f-confirm-actions"><button type="button" class="f-btn secondary" data-publish="cancel">Cancel</button><button type="button" class="f-btn" data-publish="confirm" ${current ? "" : "disabled"}>Publish form</button></div></div>`;
	host().appendChild(dialog);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: RespondentAccessChoice | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
			dialog.close();
			dialog.remove();
		};
		const confirm = dialog.querySelector<HTMLButtonElement>(
			'[data-publish="confirm"]',
		);
		dialog.addEventListener("change", (event) => {
			if ((event.target as HTMLInputElement).name === "respondent-access")
				if (confirm) confirm.disabled = false;
		});
		dialog.addEventListener("click", (event) => {
			if (event.target === dialog) return finish(null);
			const action = (event.target as Element)
				.closest("[data-publish]")
				?.getAttribute("data-publish");
			if (action === "cancel") return finish(null);
			if (action === "confirm") {
				const selected = dialog.querySelector<HTMLInputElement>(
					'input[name="respondent-access"]:checked',
				);
				if (
					selected?.value === "public" ||
					selected?.value === "verified_email"
				)
					finish(selected.value);
			}
		});
		dialog.addEventListener("cancel", (event) => {
			event.preventDefault();
			finish(null);
		});
		dialog.showModal();
		(
			dialog.querySelector<HTMLInputElement>(
				`input[name="respondent-access"]:checked`,
			) ??
			dialog.querySelector<HTMLInputElement>('input[name="respondent-access"]')
		)?.focus();
	});
}

export function confirmAction({
	title,
	message = "",
	confirmLabel = "Confirm",
	cancelLabel = "Cancel",
	danger = false,
}: ConfirmOptions): Promise<boolean> {
	const dialog = document.createElement("dialog");
	dialog.className = `f-confirm${danger ? " danger" : ""}`;
	dialog.setAttribute("aria-labelledby", "f-confirm-title");
	if (message) dialog.setAttribute("aria-describedby", "f-confirm-message");
	dialog.innerHTML = `<div class="f-confirm-body"><span class="f-confirm-icon" aria-hidden="true">${formsIcon(danger ? "trash" : "check", 22)}</span><h2 id="f-confirm-title">${escapeHtml(title)}</h2>${message ? `<p id="f-confirm-message">${escapeHtml(message)}</p>` : ""}<div class="f-confirm-actions"><button type="button" class="f-btn secondary" data-confirm="cancel">${escapeHtml(cancelLabel)}</button><button type="button" class="f-btn${danger ? " danger" : ""}" data-confirm="confirm">${escapeHtml(confirmLabel)}</button></div></div>`;
	host().appendChild(dialog);
	return new Promise((resolve) => {
		// Settle synchronously from the user's action; the dialog `close` event is
		// queued as a task and can be delayed indefinitely in background tabs.
		let settled = false;
		const finish = (confirmed: boolean) => {
			if (settled) return;
			settled = true;
			resolve(confirmed);
			dialog.close();
			dialog.remove();
		};
		dialog.addEventListener("click", (event) => {
			const target = event.target as Element;
			// A click on the backdrop lands on the dialog element itself.
			if (target === dialog) return finish(false);
			const choice = target
				.closest("[data-confirm]")
				?.getAttribute("data-confirm");
			if (choice) finish(choice === "confirm");
		});
		dialog.addEventListener("cancel", (event) => {
			event.preventDefault();
			finish(false);
		});
		dialog.showModal();
		// Destructive actions start on Cancel so Enter never deletes by accident.
		(
			dialog.querySelector(
				danger ? '[data-confirm="cancel"]' : '[data-confirm="confirm"]',
			) as HTMLButtonElement | null
		)?.focus();
	});
}

export type ToastOptions = {
	tone?: "default" | "success" | "error";
	action?: { label: string; onClick: () => void };
	duration?: number;
};

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function showToast(
	text: string,
	{
		tone = "default",
		action,
		duration = action ? 6000 : 3200,
	}: ToastOptions = {},
) {
	let node = host().querySelector<HTMLElement>(".f-toast");
	if (!node) {
		node = document.createElement("div");
		node.className = "f-toast";
		host().appendChild(node);
	}
	clearTimeout(toastTimer);
	node.dataset.tone = tone;
	node.setAttribute("role", tone === "error" ? "alert" : "status");
	const icon =
		tone === "error"
			? formsIcon("close", 16)
			: tone === "success"
				? formsIcon("check", 16)
				: "";
	node.innerHTML = `${icon}<span>${escapeHtml(text)}</span>${action ? `<button type="button" class="f-toast-action">${escapeHtml(action.label)}</button>` : ""}`;
	node.hidden = false;
	// Restart the entrance animation for consecutive toasts.
	node.style.animation = "none";
	void node.offsetWidth;
	node.style.animation = "";
	const hide = () => {
		if (node) node.hidden = true;
	};
	node.querySelector(".f-toast-action")?.addEventListener(
		"click",
		() => {
			action?.onClick();
			hide();
		},
		{ once: true },
	);
	toastTimer = setTimeout(hide, duration);
}

export const errorMessage = (error: unknown, fallback: string) =>
	error instanceof Error && error.message ? error.message : fallback;
