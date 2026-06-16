import type { bioLinks, bioPages } from "@urlx/db";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

export type BioPage = InferSelectModel<typeof bioPages>;
export type NewBioPage = InferInsertModel<typeof bioPages>;

export type BioLink = InferSelectModel<typeof bioLinks>;
export type NewBioLink = InferInsertModel<typeof bioLinks>;
