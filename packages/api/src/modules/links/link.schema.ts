import { z } from "zod";

import { shortCodePattern } from "../../lib/validate-short-code";

export const shortenInputSchema = z.object({
	url: z.string(),
});

export const shortenOutputSchema = z.object({
	shortCode: z.string(),
	shortUrl: z.url(),
});

export const getLinkInputSchema = z.object({
	shortCode: z.string().regex(shortCodePattern),
});

export const getLinkOutputSchema = z.object({
	originalUrl: z.url(),
});

export type ShortenInput = z.infer<typeof shortenInputSchema>;
export type ShortenOutput = z.infer<typeof shortenOutputSchema>;
export type GetLinkInput = z.infer<typeof getLinkInputSchema>;
export type GetLinkOutput = z.infer<typeof getLinkOutputSchema>;
