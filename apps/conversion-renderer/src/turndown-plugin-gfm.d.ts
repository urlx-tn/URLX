declare module "turndown-plugin-gfm" {
	import type TurndownService from "turndown";
	export const gfm: Parameters<TurndownService["use"]>[0];
}
