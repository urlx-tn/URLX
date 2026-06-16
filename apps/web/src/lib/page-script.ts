export function registerPageScript<T extends Element>(
	selector: string,
	setup: (root: T, signal: AbortSignal) => void,
) {
	document.addEventListener("astro:page-load", () => {
		const root = document.querySelector<T>(selector);
		if (!root) return;

		const controller = new AbortController();
		document.addEventListener("astro:before-swap", () => controller.abort(), {
			once: true,
		});

		setup(root, controller.signal);
	});
}
