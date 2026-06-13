import { z } from "zod";

export const shortenInputSchema = z.object({
	url: z.string(),
});

export const shortenOutputSchema = z.object({
	shortCode: z.string(),
	shortUrl: z.url(),
});

export type ShortenInput = z.infer<typeof shortenInputSchema>;
export type ShortenOutput = z.infer<typeof shortenOutputSchema>;
