import { z } from "zod";

export const maxBioTitleLength = 80;
export const maxBioDescriptionLength = 300;
export const maxBioLinkLabelLength = 60;
export const maxBioLinks = 25;

export const bioLinkInputSchema = z.object({
	label: z.string(),
	url: z.string(),
});

export const createBioInputSchema = z.object({
	title: z.string(),
	description: z.string().optional(),
	slug: z.string().optional(),
	links: z.array(bioLinkInputSchema),
});

export const createBioOutputSchema = z.object({
	slug: z.string(),
});

export const getBioInputSchema = z.object({
	slug: z.string(),
});

export const bioLinkOutputSchema = z.object({
	label: z.string(),
	url: z.url(),
});

export const getBioOutputSchema = z.object({
	slug: z.string(),
	title: z.string(),
	description: z.string().nullable(),
	links: z.array(bioLinkOutputSchema),
});

export type CreateBioInput = z.infer<typeof createBioInputSchema>;
export type CreateBioOutput = z.infer<typeof createBioOutputSchema>;
export type GetBioInput = z.infer<typeof getBioInputSchema>;
export type GetBioOutput = z.infer<typeof getBioOutputSchema>;
