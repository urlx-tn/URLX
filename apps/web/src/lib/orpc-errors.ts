import { ORPCError } from "@orpc/client";

export function isOrpcErrorCode(error: unknown, code: string) {
	return error instanceof ORPCError && error.code === code;
}
