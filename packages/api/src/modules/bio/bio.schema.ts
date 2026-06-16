import { z } from "zod";

export const maxBioTitleLength = 80;
export const maxBioDescriptionLength = 300;
export const maxBioLinkLabelLength = 60;
export const maxBioLinks = 25;
export const maxBioSearchQueryLength = 80;
export const defaultBioSearchPageSize = 8;
export const maxBioSearchPageSize = 24;

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

export const checkBioSlugInputSchema = z.object({
	slug: z.string(),
});

export const checkBioSlugOutputSchema = z.object({
	slug: z.string(),
	available: z.boolean(),
	reason: z.enum(["INVALID_SLUG", "RESERVED_SLUG", "SLUG_TAKEN"]).nullable(),
});

export const searchBioInputSchema = z.object({
	query: z.string().max(maxBioSearchQueryLength).optional(),
	page: z.number().int().min(1).optional(),
	pageSize: z.number().int().min(1).max(maxBioSearchPageSize).optional(),
});

export const bioSearchItemOutputSchema = z.object({
	slug: z.string(),
	title: z.string(),
	description: z.string().nullable(),
	createdAt: z.number(),
});

export const searchBioOutputSchema = z.object({
	query: z.string(),
	page: z.number(),
	pageSize: z.number(),
	totalItems: z.number(),
	totalPages: z.number(),
	items: z.array(bioSearchItemOutputSchema),
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
export type CheckBioSlugInput = z.infer<typeof checkBioSlugInputSchema>;
export type CheckBioSlugOutput = z.infer<typeof checkBioSlugOutputSchema>;
export type SearchBioInput = z.infer<typeof searchBioInputSchema>;
export type SearchBioOutput = z.infer<typeof searchBioOutputSchema>;
export type GetBioInput = z.infer<typeof getBioInputSchema>;
export type GetBioOutput = z.infer<typeof getBioOutputSchema>;
