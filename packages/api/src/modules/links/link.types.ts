import type { links } from "@urlx/db";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

export type Link = InferSelectModel<typeof links>;
export type NewLink = InferInsertModel<typeof links>;
