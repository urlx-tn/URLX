import { os } from "@orpc/server";

import type { Context } from "./context";

export const o = os.$context<Context>();

export const publicProcedure = o;

export type {
	FormAccentId,
	FormAnswersDto,
	FormAnswerValue,
	FormDefinitionDto,
	FormFieldDto,
	FormFieldType,
} from "./modules/forms/forms.types";
