export const primaryProducts = [
	{
		label: "URL Shortener",
		navLabel: "Shortener",
		href: "/tools/url-shortener",
		description: "Create short, shareable links",
		category: "Create",
	},
	{
		label: "QR Code Generator",
		navLabel: "QR Codes",
		href: "/tools/qr-code-generator",
		description: "Generate QR codes for any URL",
		category: "Create",
	},
	{
		label: "Link in Bio",
		navLabel: "Link in Bio",
		href: "/tools/link-in-bio",
		description: "Share every link from one page",
		category: "Create",
	},
] as const;

export const additionalTools = [
	{
		label: "URL Cleaner",
		description: "Remove tracking parameters",
		href: "/tools/url-cleaner",
		category: "Clean",
	},
	{
		label: "URL to Markdown",
		description: "Turn webpages into Markdown",
		href: "/tools/url-to-markdown",
		category: "Convert",
	},
	{
		label: "URL to HTML",
		description: "Capture rendered webpage HTML",
		href: "/tools/url-to-html",
		category: "Convert",
	},
] as const;

export const allToolsLink = {
	label: "All tools",
	href: "/tools",
} as const;

export const isNavigationLinkActive = (currentPath: string, href: string) =>
	currentPath === href || currentPath.startsWith(`${href}/`);
