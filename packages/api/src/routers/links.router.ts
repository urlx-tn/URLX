import { ORPCError } from "@orpc/server";

import { publicProcedure } from "../index";
import { LinkError, toLinkError } from "../modules/links/link.errors";
import {
	shortenInputSchema,
	shortenOutputSchema,
} from "../modules/links/link.schema";
import { LinkService } from "../modules/links/link.service";

export const linksRouter = {
	shorten: publicProcedure
		.input(shortenInputSchema)
		.output(shortenOutputSchema)
		.handler(async ({ context, input }) => {
			try {
				const service = new LinkService({
					db: context.db,
					shortUrlBase: context.shortUrlBase,
				});

				return await service.shorten(input.url);
			} catch (error) {
				const linkError =
					error instanceof LinkError ? error : toLinkError(error);

				throw new ORPCError(linkError.code, {
					data: {
						code: linkError.code,
						message: linkError.message,
					},
					message: linkError.message,
					status: linkError.status,
				});
			}
		}),
};
