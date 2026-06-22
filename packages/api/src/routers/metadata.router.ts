import { ORPCError } from "@orpc/server";

import { publicProcedure } from "../index";
import {
	MetadataError,
	toMetadataError,
} from "../modules/metadata/metadata.errors";
import {
	inspectMetadataInputSchema,
	inspectMetadataOutputSchema,
} from "../modules/metadata/metadata.schema";
import { MetadataService } from "../modules/metadata/metadata.service";

export const metadataRouter = {
	inspect: publicProcedure
		.input(inspectMetadataInputSchema)
		.output(inspectMetadataOutputSchema)
		.handler(async ({ context, input }) => {
			try {
				const service = new MetadataService({
					fetcher: context.fetcher,
					now: context.now,
					rateLimiter: context.metadataRateLimiter,
					rateLimitKey: context.metadataRateLimitKey,
				});

				return await service.inspect(input.url);
			} catch (error) {
				const metadataError =
					error instanceof MetadataError ? error : toMetadataError(error);

				throw new ORPCError(metadataError.code, {
					data: {
						code: metadataError.code,
						message: metadataError.message,
					},
					message: metadataError.message,
					status: metadataError.status,
				});
			}
		}),
};
