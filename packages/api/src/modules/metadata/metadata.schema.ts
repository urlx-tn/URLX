import { z } from "zod";

export const inspectMetadataInputSchema = z.object({
	url: z.string(),
});

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();

export const metadataWarningSeveritySchema = z.enum([
	"info",
	"warning",
	"error",
]);

export const metadataWarningSchema = z.object({
	code: z.string(),
	severity: metadataWarningSeveritySchema,
	message: z.string(),
});

export const metadataRedirectSchema = z.object({
	from: z.url(),
	to: z.url(),
	status: z.number(),
});

export const metadataImageSchema = z.object({
	url: z.url(),
	secureUrl: nullableString,
	type: nullableString,
	width: nullableNumber,
	height: nullableNumber,
	alt: nullableString,
});

export const inspectMetadataOutputSchema = z.object({
	sourceUrl: z.url(),
	finalUrl: z.url(),
	status: z.number(),
	ok: z.boolean(),
	contentType: nullableString,
	checkedAt: z.iso.datetime(),
	redirects: z.array(metadataRedirectSchema),
	title: nullableString,
	description: nullableString,
	canonicalUrl: nullableString,
	language: nullableString,
	charset: nullableString,
	viewport: nullableString,
	robots: nullableString,
	themeColor: nullableString,
	faviconUrl: nullableString,
	openGraph: z.object({
		title: nullableString,
		description: nullableString,
		url: nullableString,
		type: nullableString,
		siteName: nullableString,
		locale: nullableString,
		images: z.array(metadataImageSchema),
	}),
	twitter: z.object({
		card: nullableString,
		site: nullableString,
		creator: nullableString,
		title: nullableString,
		description: nullableString,
		image: nullableString,
		imageAlt: nullableString,
	}),
	preview: z.object({
		title: nullableString,
		description: nullableString,
		imageUrl: nullableString,
		imageAlt: nullableString,
		siteName: nullableString,
		url: z.url(),
		faviconUrl: nullableString,
	}),
	rawTags: z.array(
		z.object({
			source: z.enum(["title", "meta", "link", "html"]),
			name: z.string(),
			value: z.string(),
		}),
	),
	warnings: z.array(metadataWarningSchema),
});

export type InspectMetadataInput = z.infer<typeof inspectMetadataInputSchema>;
export type InspectMetadataOutput = z.infer<typeof inspectMetadataOutputSchema>;
export type MetadataWarning = z.infer<typeof metadataWarningSchema>;
