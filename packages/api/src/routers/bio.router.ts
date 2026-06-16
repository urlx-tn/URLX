import { ORPCError } from "@orpc/server";

import { publicProcedure } from "../index";
import { BioError, toBioError } from "../modules/bio/bio.errors";
import {
	checkBioSlugInputSchema,
	checkBioSlugOutputSchema,
	createBioInputSchema,
	createBioOutputSchema,
	getBioInputSchema,
	getBioOutputSchema,
	searchBioInputSchema,
	searchBioOutputSchema,
} from "../modules/bio/bio.schema";
import { BioService } from "../modules/bio/bio.service";
import { LinkError } from "../modules/links/link.errors";

// The bio service reuses the shortener's URL validator, which throws LinkError.
// Surface those as-is (their codes are already frontend-safe), and map anything
// else through the bio error contract.
function toClientError(error: unknown) {
	if (error instanceof LinkError) {
		return {
			code: error.code,
			message: error.message,
			status: error.status,
		};
	}

	const bioError = error instanceof BioError ? error : toBioError(error);

	return {
		code: bioError.code,
		message: bioError.message,
		status: bioError.status,
	};
}

export const bioRouter = {
	create: publicProcedure
		.input(createBioInputSchema)
		.output(createBioOutputSchema)
		.handler(async ({ context, input }) => {
			try {
				const service = new BioService({ db: context.db });
				return await service.createBioPage(input);
			} catch (error) {
				const clientError = toClientError(error);

				throw new ORPCError(clientError.code, {
					data: { code: clientError.code, message: clientError.message },
					message: clientError.message,
					status: clientError.status,
				});
			}
		}),

	checkSlug: publicProcedure
		.input(checkBioSlugInputSchema)
		.output(checkBioSlugOutputSchema)
		.handler(async ({ context, input }) => {
			try {
				const service = new BioService({ db: context.db });
				return await service.checkSlugAvailability(input.slug);
			} catch (error) {
				const clientError = toClientError(error);

				throw new ORPCError(clientError.code, {
					data: { code: clientError.code, message: clientError.message },
					message: clientError.message,
					status: clientError.status,
				});
			}
		}),

	search: publicProcedure
		.input(searchBioInputSchema)
		.output(searchBioOutputSchema)
		.handler(async ({ context, input }) => {
			try {
				const service = new BioService({ db: context.db });
				return await service.searchBioPages(input);
			} catch (error) {
				const clientError = toClientError(error);

				throw new ORPCError(clientError.code, {
					data: { code: clientError.code, message: clientError.message },
					message: clientError.message,
					status: clientError.status,
				});
			}
		}),

	getBySlug: publicProcedure
		.input(getBioInputSchema)
		.output(getBioOutputSchema)
		.handler(async ({ context, input }) => {
			try {
				const service = new BioService({ db: context.db });
				return await service.getBioPage(input.slug);
			} catch (error) {
				const clientError = toClientError(error);

				throw new ORPCError(clientError.code, {
					data: { code: clientError.code, message: clientError.message },
					message: clientError.message,
					status: clientError.status,
				});
			}
		}),
};
