import { z } from "zod";

export const convertUrlInputSchema = z.object({
	url: z.string(),
});

export const convertMarkdownOutputSchema = z.object({
	sourceUrl: z.url(),
	markdown: z.string(),
});

export const convertHtmlOutputSchema = z.object({
	sourceUrl: z.url(),
	html: z.string(),
});

export type ConvertUrlInput = z.infer<typeof convertUrlInputSchema>;
export type ConvertMarkdownOutput = z.infer<typeof convertMarkdownOutputSchema>;
export type ConvertHtmlOutput = z.infer<typeof convertHtmlOutputSchema>;
