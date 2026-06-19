import { z } from "zod";

export const convertMarkdownInputSchema = z.object({
	url: z.string(),
});

export const convertMarkdownOutputSchema = z.object({
	sourceUrl: z.url(),
	markdown: z.string(),
});

export type ConvertMarkdownInput = z.infer<typeof convertMarkdownInputSchema>;
export type ConvertMarkdownOutput = z.infer<typeof convertMarkdownOutputSchema>;
