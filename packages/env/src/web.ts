import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const runtimeEnv = (import.meta as { env: Record<string, string | undefined> })
	.env;

export const env = createEnv({
	clientPrefix: "PUBLIC_",
	client: {
		PUBLIC_SERVER_URL: z.url(),
	},
	runtimeEnv,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
	emptyStringAsUndefined: true,
});
