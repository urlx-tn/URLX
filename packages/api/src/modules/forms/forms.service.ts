import type { UrlxDb } from "@urlx/db";
import {
	formAliases,
	formAliasTombstones,
	formLimits,
	formMonthlyUsage,
	formResponses,
	forms,
	formVersions,
} from "@urlx/db";
import {
	and,
	asc,
	count,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { LinkService } from "../links/link.service";
import {
	type FormDefinitionDto,
	type FormFieldDto,
	formAccentIds,
	formFieldTypes,
	type RespondentAccessMode,
	respondentAccessModes,
} from "./forms.types";

export type FormsDb = UrlxDb;
export type FormField = FormFieldDto;
export type FormDefinition = FormDefinitionDto;
export const maxFormFields = 50;
export const maxResponsesPerMonth = 1000;
export const maxRetainedResponses = 10000;
// Bounds answer JSON materialized for each stats aggregation query.
const responseStatsChunkSize = 250;
const exportPageSize = 250;

export type FormExportRow = {
	id: string;
	versionId: string;
	version: number | null;
	createdAt: number;
	fields: FormField[];
	answers: Record<string, unknown>;
};

export type FormsListOptions = {
	limit?: number;
	cursor?: string;
	search?: string;
};

type FormsListCursor = {
	updatedAt: number;
	id: string;
	search: string;
};

export class FormsService {
	constructor(
		private readonly db: FormsDb,
		private readonly now = () => Date.now(),
	) {}

	async list(ownerId: string, options: FormsListOptions = {}) {
		const search = options.search?.trim().toLowerCase() ?? "";
		if (search.includes("\0")) throw new FormsError("INVALID_SEARCH", 400);
		const requestedLimit = Number.isInteger(options.limit)
			? (options.limit as number)
			: 50;
		const limit = Math.max(1, Math.min(requestedLimit, 100));
		const cursor = options.cursor
			? decodeFormsListCursor(options.cursor)
			: null;
		if (cursor && cursor.search !== search)
			throw new FormsError("INVALID_CURSOR", 400);
		const baseConditions = [
			eq(forms.ownerId, ownerId),
			isNull(forms.disabledAt),
		];
		if (search)
			baseConditions.push(
				or(
					sql`position(${search} in lower(${forms.title})) > 0`,
					sql`position(${search} in lower(coalesce(${forms.slug}, ''))) > 0`,
				)!,
			);
		const conditions = [...baseConditions];
		if (cursor)
			conditions.push(
				or(
					lt(forms.updatedAt, cursor.updatedAt),
					and(eq(forms.updatedAt, cursor.updatedAt), lt(forms.id, cursor.id)),
				)!,
			);
		const page = await this.db
			.select()
			.from(forms)
			.where(and(...conditions))
			.orderBy(desc(forms.updatedAt), desc(forms.id))
			.limit(limit + 1);
		const hasMore = page.length > limit;
		const rows = page.slice(0, limit);
		const nextCursor = hasMore
			? encodeFormsListCursor({
					updatedAt: rows.at(-1)!.updatedAt,
					id: rows.at(-1)!.id,
					search,
				})
			: null;
		const [matchingCount] = await this.db
			.select({ total: count() })
			.from(forms)
			.where(and(...baseConditions));
		const [allFormsCount] = search
			? await this.db
					.select({ total: count() })
					.from(forms)
					.where(and(eq(forms.ownerId, ownerId), isNull(forms.disabledAt)))
			: [matchingCount];
		const month = new Date(this.now()).toISOString().slice(0, 7);
		const [usage] = await this.db
			.select()
			.from(formMonthlyUsage)
			.where(
				and(
					eq(formMonthlyUsage.ownerId, ownerId),
					eq(formMonthlyUsage.month, month),
				),
			)
			.limit(1);
		const limits = await this.getLimits();
		const responseCounts = rows.length
			? await this.db
					.select({ formId: formResponses.formId, total: count() })
					.from(formResponses)
					.where(
						inArray(
							formResponses.formId,
							rows.map((form) => form.id),
						),
					)
					.groupBy(formResponses.formId)
			: [];
		const responseCountsByForm = new Map(
			responseCounts.map((response) => [
				response.formId,
				Number(response.total),
			]),
		);
		const publishedVersions = rows.length
			? await this.getLatestPublishedVersionsForForms(
					rows.map((form) => form.id),
				)
			: new Map();
		return {
			forms: rows.map((form) => ({
				...form,
				publishedVersion: publishedVersions.get(form.id) ?? null,
				responseCount: responseCountsByForm.get(form.id) ?? 0,
			})),
			usage: {
				month,
				responses: usage?.responseCount ?? 0,
				forms: Number(allFormsCount?.total ?? 0),
				monthlyLimit: limits.maxMonthlyResponses,
				publishedLimit: limits.maxPublished,
				retainedLimit: limits.maxRetainedResponses,
			},
			totalForms: Number(matchingCount?.total ?? 0),
			nextCursor,
		};
	}

	async get(ownerId: string, id: string) {
		if (id.includes("\0")) return null;
		const [form] = await this.db
			.select()
			.from(forms)
			.where(
				and(
					eq(forms.id, id),
					eq(forms.ownerId, ownerId),
					isNull(forms.disabledAt),
				),
			)
			.limit(1);
		if (!form) return null;
		const [draftVersion] = await this.db
			.select()
			.from(formVersions)
			.where(eq(formVersions.formId, id))
			.orderBy(desc(formVersions.version))
			.limit(1);
		const month = new Date(this.now()).toISOString().slice(0, 7);
		const [usage] = await this.db
			.select()
			.from(formMonthlyUsage)
			.where(
				and(
					eq(formMonthlyUsage.ownerId, ownerId),
					eq(formMonthlyUsage.month, month),
				),
			)
			.limit(1);
		const limits = await this.getLimits();
		const publishedVersion = await this.getPublishedVersion(id);
		return {
			form: { ...form, publishedVersion },
			draft: draftVersion
				? {
						title: draftVersion.title,
						description: draftVersion.description ?? "",
						accent: draftVersion.accent,
						confirmationMessage: draftVersion.confirmationMessage ?? "",
						fields: parseFields(draftVersion.fieldsJson),
					}
				: null,
			revision: draftVersion?.version ?? 0,
			publishedVersion,
			usage: {
				month,
				responses: usage?.responseCount ?? 0,
				monthlyLimit: limits.maxMonthlyResponses,
				publishedLimit: limits.maxPublished,
				retainedLimit: limits.maxRetainedResponses,
			},
		};
	}

	async create(ownerId: string, definition: FormDefinition) {
		const clean = validateDefinition(definition);
		const now = this.now();
		const formId = crypto.randomUUID();
		const versionId = crypto.randomUUID();
		await this.db.transaction(async (tx) => {
			await tx.insert(forms).values({
				id: formId,
				ownerId,
				title: clean.title,
				description: clean.description ?? null,
				theme: "light",
				accent: clean.accent,
				confirmationMessage: clean.confirmationMessage ?? null,
				slug: null,
				shortCode: null,
				createdAt: now,
				updatedAt: now,
				disabledAt: null,
			});
			await tx.insert(formVersions).values({
				id: versionId,
				formId,
				version: 1,
				fieldsJson: JSON.stringify(clean.fields),
				title: clean.title,
				description: clean.description ?? null,
				confirmationMessage: clean.confirmationMessage ?? null,
				accent: clean.accent,
				createdAt: now,
				publishedAt: null,
			});
		});
		return this.get(ownerId, formId);
	}

	async save(
		ownerId: string,
		id: string,
		definition: FormDefinition,
		revision?: number,
	) {
		const clean = validateDefinition(definition);
		const current = await this.getDraftState(ownerId, id);
		if (!current || !current.draft) return null;
		if (revision !== undefined && revision !== current.revision)
			throw new FormsError(
				"REVISION_CONFLICT",
				409,
				JSON.stringify({ draft: current.draft, revision: current.revision }),
			);
		const now = this.now();
		const nextVersion = current.revision + 1;
		try {
			await this.db.transaction(async (tx) => {
				await tx.execute(sql`select public.lock_form_owner(${ownerId})`);
				await tx
					.delete(formVersions)
					.where(
						and(
							eq(formVersions.formId, id),
							isNull(formVersions.publishedAt),
							lte(formVersions.version, current.revision),
						),
					);
				await tx
					.update(forms)
					.set({
						title: clean.title,
						description: clean.description ?? null,
						accent: clean.accent,
						confirmationMessage: clean.confirmationMessage ?? null,
						updatedAt: now,
					})
					.where(and(eq(forms.id, id), eq(forms.ownerId, ownerId)));
				await tx.insert(formVersions).values({
					id: crypto.randomUUID(),
					formId: id,
					version: nextVersion,
					fieldsJson: JSON.stringify(clean.fields),
					title: clean.title,
					description: clean.description ?? null,
					confirmationMessage: clean.confirmationMessage ?? null,
					accent: clean.accent,
					createdAt: now,
					publishedAt: null,
				});
			});
		} catch (error) {
			const latest = await this.getDraftState(ownerId, id);
			if (latest && latest.revision !== current.revision)
				throw new FormsError(
					"REVISION_CONFLICT",
					409,
					JSON.stringify({ draft: latest.draft, revision: latest.revision }),
				);
			throw error;
		}
		return {
			draft: {
				title: clean.title,
				description: clean.description ?? "",
				accent: clean.accent,
				confirmationMessage: clean.confirmationMessage ?? "",
				fields: clean.fields,
			},
			revision: nextVersion,
		};
	}

	async publish(
		ownerId: string,
		id: string,
		requestedSlug: string | undefined,
		publicBaseUrl: string,
		shortUrlBase: string,
		respondentAccess: RespondentAccessMode,
	) {
		if (!respondentAccessModes.includes(respondentAccess))
			throw new FormsError("RESPONDENT_ACCESS_REQUIRED", 400);
		let current = await this.get(ownerId, id);
		if (!current || !current.draft) return null;
		// A blank draft can be saved, but respondents should never see an empty form.
		if (!current.draft.fields?.length)
			throw new FormsError(
				"NO_QUESTIONS",
				400,
				"Add at least one question before publishing.",
			);
		if (requestedSlug) await this.setSlug(ownerId, id, requestedSlug);
		current = await this.get(ownerId, id);
		if (!current?.form.slug) {
			const titleSlug = current?.draft?.title
				.toLowerCase()
				.normalize("NFKD")
				.replace(/[\u0300-\u036f]/g, "")
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 38)
				.replace(/-+$/g, "");
			const idSuffix = id
				.replace(/[^a-z0-9]/gi, "")
				.slice(-8)
				.toLowerCase();
			await this.setSlug(
				ownerId,
				id,
				`${titleSlug || "form"}-${idSuffix || "link"}`,
			);
			current = await this.get(ownerId, id);
		}
		if (!current?.form.slug) throw new FormsError("SLUG_REQUIRED", 409);
		const [latest] = await this.db
			.select()
			.from(formVersions)
			.where(
				and(
					eq(formVersions.formId, id),
					eq(formVersions.version, current.revision),
				),
			)
			.limit(1);
		const now = this.now();
		if (!latest) throw new FormsError("DRAFT_NOT_FOUND", 409);
		// Published versions are immutable. Re-publishing without an intervening
		// draft still creates a snapshot so the access decision has its own version.
		const publishedVersionId =
			latest.publishedAt !== null ? crypto.randomUUID() : latest.id;
		try {
			if (latest.publishedAt !== null) {
				await this.db.transaction(async (tx) => {
					await tx.execute(sql`select public.lock_form_owner(${ownerId})`);
					await tx.insert(formVersions).values({
						id: publishedVersionId,
						formId: id,
						version: latest.version + 1,
						fieldsJson: latest.fieldsJson,
						title: latest.title,
						description: latest.description,
						confirmationMessage: latest.confirmationMessage,
						accent: latest.accent,
						respondentAccess,
						createdAt: now,
						publishedAt: now,
					});
					await tx
						.update(forms)
						.set({ updatedAt: now })
						.where(and(eq(forms.id, id), eq(forms.ownerId, ownerId)));
				});
			} else {
				const published = await this.db.transaction(async (tx) => {
					await tx.execute(sql`select public.lock_form_owner(${ownerId})`);
					const [updated] = await tx
						.update(formVersions)
						.set({ publishedAt: now, respondentAccess })
						.where(
							and(
								eq(formVersions.id, latest.id),
								eq(formVersions.formId, id),
								isNull(formVersions.publishedAt),
							),
						)
						.returning({ id: formVersions.id });
					await tx
						.update(forms)
						.set({ updatedAt: now })
						.where(and(eq(forms.id, id), eq(forms.ownerId, ownerId)));
					return updated;
				});
				if (!published) throw new FormsError("REVISION_CONFLICT", 409);
			}
		} catch (error) {
			if (error instanceof FormsError) throw error;
			if (errorText(error).includes("forms_owner_published_limit"))
				throw new FormsError("PUBLISHED_FORM_LIMIT", 409);
			if (
				errorText(error).includes(
					"form_versions.form_id, form_versions.version",
				) ||
				pgConstraint(error) === "form_versions_form_version_unique"
			)
				throw new FormsError("REVISION_CONFLICT", 409);
			throw error;
		}
		let shortCode = current.form.shortCode;
		if (!shortCode) {
			const link = await new LinkService({ db: this.db, shortUrlBase }).shorten(
				new URL(
					`/f/${encodeURIComponent(current.form.slug)}`,
					publicBaseUrl,
				).toString(),
			);
			shortCode = new URL(link.shortUrl).pathname.split("/").at(-1) ?? null;
			if (shortCode)
				await this.db
					.update(forms)
					.set({ shortCode })
					.where(
						and(
							eq(forms.id, id),
							eq(forms.ownerId, ownerId),
							isNull(forms.disabledAt),
						),
					);
		}
		const result = await this.get(ownerId, id);
		return result
			? {
					...result,
					form: { ...result.form, slug: current.form.slug },
					version: publishedVersionId,
					url: new URL(
						`/f/${encodeURIComponent(current.form.slug)}`,
						publicBaseUrl,
					).toString(),
					shortUrl: shortCode
						? `${shortUrlBase.replace(/\/+$/, "")}/u/${shortCode}`
						: null,
				}
			: null;
	}

	async setSlug(
		ownerId: string,
		id: string,
		rawSlug: string,
		publicBaseUrl?: string,
		shortUrlBase?: string,
	) {
		const slug = rawSlug.trim().toLowerCase();
		if (!/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])?$/.test(slug))
			throw new FormsError("INVALID_SLUG", 400);
		if (!(await this.getOwnedFormId(ownerId, id))) return null;
		const current = await this.db.transaction(async (tx) => {
			await tx.execute(sql`select public.lock_form_owner(${ownerId})`);
			const [form] = await tx
				.select({ id: forms.id })
				.from(forms)
				.where(
					and(
						eq(forms.id, id),
						eq(forms.ownerId, ownerId),
						isNull(forms.disabledAt),
					),
				)
				.limit(1)
				.for("update");
			if (!form) return null;

			await tx.execute(sql`select public.lock_form_alias(${slug})`);
			const [alias] = await tx
				.select()
				.from(formAliases)
				.where(eq(formAliases.alias, slug))
				.limit(1);
			if (alias && alias.formId !== id) throw new FormsError("SLUG_TAKEN", 409);
			const [tombstone] = await tx
				.select()
				.from(formAliasTombstones)
				.where(eq(formAliasTombstones.alias, slug))
				.limit(1);
			if (tombstone) throw new FormsError("SLUG_TAKEN", 409);
			if (!alias)
				await tx
					.insert(formAliases)
					.values({ alias: slug, formId: id, createdAt: this.now() })
					.onConflictDoNothing();
			const [updated] = await tx
				.update(forms)
				.set({ slug, updatedAt: this.now() })
				.where(and(eq(forms.id, id), eq(forms.ownerId, ownerId)))
				.returning({ id: forms.id });
			return updated?.id ?? null;
		});
		if (!current) return null;
		const result = await this.get(ownerId, id);
		return result
			? {
					form: { ...result.form, slug },
					url: publicBaseUrl
						? new URL(
								`/f/${encodeURIComponent(slug)}`,
								publicBaseUrl,
							).toString()
						: `/f/${encodeURIComponent(slug)}`,
					shortUrl:
						result.form.shortCode && shortUrlBase
							? `${shortUrlBase.replace(/\/+$/, "")}/u/${result.form.shortCode}`
							: null,
				}
			: null;
	}

	async delete(ownerId: string, id: string) {
		if (id.includes("\0")) return false;
		const deleted = await this.db.transaction(async (tx) => {
			await tx.execute(sql`select public.lock_form_owner(${ownerId})`);
			return tx
				.delete(forms)
				.where(
					and(
						eq(forms.id, id),
						eq(forms.ownerId, ownerId),
						isNull(forms.disabledAt),
					),
				)
				.returning({ id: forms.id });
		});
		return deleted.length > 0;
	}

	async getPublic(slug: string) {
		if (slug.includes("\0")) return null;
		const [alias] = await this.db
			.select()
			.from(formAliases)
			.where(eq(formAliases.alias, slug.toLowerCase()))
			.limit(1);
		if (!alias) return null;
		const [form] = await this.db
			.select()
			.from(forms)
			.where(and(eq(forms.id, alias.formId), isNull(forms.disabledAt)))
			.limit(1);
		if (!form) return null;
		const version = await this.getPublishedVersion(form.id);
		return version
			? {
					form,
					version,
					requestedSlug: slug.toLowerCase(),
					canonicalSlug: form.slug,
				}
			: null;
	}

	async getVersion(formId: string, versionId: string) {
		const [version] = await this.db
			.select()
			.from(formVersions)
			.where(
				and(
					eq(formVersions.formId, formId),
					eq(formVersions.id, versionId),
					sql`${formVersions.publishedAt} is not null`,
				),
			)
			.limit(1);
		return version
			? {
					id: version.id,
					version: version.version,
					title: version.title,
					description: version.description ?? "",
					confirmationMessage: version.confirmationMessage ?? "",
					fields: parseFields(version.fieldsJson),
					accent: version.accent,
					respondentAccess: version.respondentAccess as RespondentAccessMode,
					publishedAt: version.publishedAt,
				}
			: null;
	}

	async acceptResponse(
		formId: string,
		versionId: string,
		key: string,
		answers: Record<string, unknown>,
	) {
		if (!key || key.length > 128)
			throw new FormsError("INVALID_SUBMISSION_KEY", 400);
		const responseId = crypto.randomUUID();
		try {
			const result = await this.db.transaction(async (tx) => {
				const [form] = await tx
					.select({ ownerId: forms.ownerId })
					.from(forms)
					.where(eq(forms.id, formId))
					.limit(1);
				if (!form) throw new FormsError("FORM_VERSION_CLOSED", 409);
				await tx.execute(sql`select public.lock_form_owner(${form.ownerId})`);
				const [existing] = await tx
					.select({ id: formResponses.id })
					.from(formResponses)
					.where(
						and(
							eq(formResponses.formId, formId),
							eq(formResponses.idempotencyKey, key),
						),
					)
					.limit(1);
				if (existing) return { responseId: existing.id, duplicate: true };
				const [publishedVersion] = await tx
					.select({ id: formVersions.id })
					.from(formVersions)
					.innerJoin(forms, eq(forms.id, formVersions.formId))
					.where(
						and(
							eq(forms.id, formId),
							isNull(forms.disabledAt),
							eq(formVersions.id, versionId),
							isNotNull(formVersions.publishedAt),
						),
					)
					.limit(1);
				if (!publishedVersion) throw new FormsError("FORM_VERSION_CLOSED", 409);
				await tx.insert(formResponses).values({
					id: responseId,
					formId,
					versionId,
					idempotencyKey: key,
					answersJson: JSON.stringify(answers),
					createdAt: this.now(),
				});
				return { responseId, duplicate: false };
			});
			return result;
		} catch (error) {
			if (errorText(error).includes("forms_owner_monthly_quota"))
				throw new FormsError("QUOTA_EXCEEDED", 429);
			if (
				errorText(error).includes("forms_collection_closed") ||
				pgCode(error) === "23503"
			)
				throw new FormsError("FORM_VERSION_CLOSED", 409);
			if (
				pgCode(error) === "23505" &&
				pgConstraint(error) === "form_responses_idempotency_unique"
			) {
				const [existing] = await this.db
					.select({ id: formResponses.id })
					.from(formResponses)
					.where(
						and(
							eq(formResponses.formId, formId),
							eq(formResponses.idempotencyKey, key),
						),
					)
					.limit(1);
				if (existing) return { responseId: existing.id, duplicate: true };
			}
			throw error;
		}
	}

	async responses(ownerId: string, id: string, limit = 100, offset = 0) {
		if (!(await this.getOwnedFormId(ownerId, id))) return null;
		const rows = await this.db
			.select()
			.from(formResponses)
			.where(eq(formResponses.formId, id))
			.orderBy(desc(formResponses.createdAt))
			.limit(limit)
			.offset(offset);
		const versions = await this.db
			.select({
				id: formVersions.id,
				version: formVersions.version,
				fieldsJson: formVersions.fieldsJson,
			})
			.from(formVersions)
			.leftJoin(
				formResponses,
				and(
					eq(formResponses.versionId, formVersions.id),
					eq(formResponses.formId, id),
				),
			)
			.where(eq(formVersions.formId, id))
			.groupBy(formVersions.id)
			.having(
				or(
					gt(count(formResponses.id), 0),
					and(
						isNull(formVersions.publishedAt),
						eq(
							formVersions.version,
							sql`(select max("draft"."version") from "form_versions" as "draft" where "draft"."form_id" = ${formVersions.formId} and "draft"."published_at" is null)`,
						),
					),
					eq(
						formVersions.version,
						sql`(select max("latest"."version") from "form_versions" as "latest" where "latest"."form_id" = ${formVersions.formId} and "latest"."published_at" is not null)`,
					),
				)!,
			);
		const versionsById = new Map(
			versions.map((version) => [version.id, version]),
		);
		const responses = rows.map((row) => ({
			id: row.id,
			versionId: row.versionId,
			answers: JSON.parse(row.answersJson) as Record<string, unknown>,
			createdAt: row.createdAt,
			version: versionsById.get(row.versionId)?.version ?? null,
		}));
		const [totals] = await this.db
			.select({
				total: count(),
				last7Days:
					sql<number>`coalesce(sum(case when ${formResponses.createdAt} >= ${this.now() - 7 * 24 * 60 * 60 * 1000} then 1 else 0 end), 0)`.mapWith(
						Number,
					),
			})
			.from(formResponses)
			.where(eq(formResponses.formId, id));
		const [usage] = await this.db
			.select()
			.from(formMonthlyUsage)
			.where(
				and(
					eq(formMonthlyUsage.ownerId, ownerId),
					eq(
						formMonthlyUsage.month,
						new Date(this.now()).toISOString().slice(0, 7),
					),
				),
			)
			.limit(1);
		const limits = await this.getLimits();
		const stats = await this.responseStats(
			id,
			versions,
			Number(totals?.total ?? 0),
		);
		return {
			responses,
			total: Number(totals?.total ?? 0),
			last7Days: Number(totals?.last7Days ?? 0),
			offset,
			limit,
			usage: usage?.responseCount ?? 0,
			monthlyLimit: limits.maxMonthlyResponses,
			stats,
		};
	}

	async deleteResponse(ownerId: string, id: string, responseId?: string) {
		if (responseId?.includes("\0")) return null;
		if (!(await this.getOwnedFormId(ownerId, id))) return null;
		const deleted = await this.db.transaction(async (tx) => {
			await tx.execute(sql`select public.lock_form_owner(${ownerId})`);
			return responseId
				? tx
						.delete(formResponses)
						.where(
							and(
								eq(formResponses.formId, id),
								eq(formResponses.id, responseId),
							),
						)
						.returning({ id: formResponses.id })
				: tx
						.delete(formResponses)
						.where(eq(formResponses.formId, id))
						.returning({ id: formResponses.id });
		});
		return { success: true, deleted: deleted.length };
	}

	/** Pages through the initial high-water tuple; concurrent deletes and same-millisecond inserts are best-effort, not a snapshot. */
	async exportRowsInPages(
		ownerId: string,
		id: string,
		pageSize = exportPageSize,
	): Promise<AsyncIterable<FormExportRow[]> | null> {
		if (!(await this.getOwnedFormId(ownerId, id))) return null;
		const [latestResponse] = await this.db
			.select({
				createdAt: formResponses.createdAt,
				id: formResponses.id,
			})
			.from(formResponses)
			.where(eq(formResponses.formId, id))
			.orderBy(desc(formResponses.createdAt), desc(formResponses.id))
			.limit(1);
		const highWater = latestResponse ?? null;
		const limit = Math.max(
			1,
			Math.min(Math.trunc(pageSize) || exportPageSize, exportPageSize),
		);
		if (!highWater) return (async function* () {})();
		const db = this.db;
		return (async function* () {
			let cursor: { createdAt: number; id: string } | undefined;
			for (;;) {
				const conditions = [eq(formResponses.formId, id)];
				conditions.push(
					or(
						lt(formResponses.createdAt, highWater.createdAt),
						and(
							eq(formResponses.createdAt, highWater.createdAt),
							lte(formResponses.id, highWater.id),
						),
					)!,
				);
				if (cursor) {
					conditions.push(
						or(
							gt(formResponses.createdAt, cursor.createdAt),
							and(
								eq(formResponses.createdAt, cursor.createdAt),
								gt(formResponses.id, cursor.id),
							),
						)!,
					);
				}
				const rows = await db
					.select({
						id: formResponses.id,
						versionId: formResponses.versionId,
						createdAt: formResponses.createdAt,
						answersJson: formResponses.answersJson,
						version: formVersions.version,
						fieldsJson: formVersions.fieldsJson,
					})
					.from(formResponses)
					.innerJoin(
						formVersions,
						and(
							eq(formVersions.id, formResponses.versionId),
							eq(formVersions.formId, formResponses.formId),
						),
					)
					.where(and(...conditions))
					.orderBy(asc(formResponses.createdAt), asc(formResponses.id))
					.limit(limit);
				if (!rows.length) return;
				const last = rows.at(-1)!;
				cursor = { createdAt: last.createdAt, id: last.id };
				const fieldsByVersion = new Map<string, FormField[]>();
				yield rows.map((row) => {
					let fields = fieldsByVersion.get(row.versionId);
					if (!fields) {
						fields = parseFields(row.fieldsJson);
						fieldsByVersion.set(row.versionId, fields);
					}
					return {
						id: row.id,
						versionId: row.versionId,
						version: row.version,
						createdAt: row.createdAt,
						fields,
						answers: JSON.parse(row.answersJson) as Record<string, unknown>,
					};
				});
				if (rows.length < limit) return;
			}
		})();
	}

	private async responseStats(
		formId: string,
		versions: Array<
			Pick<typeof formVersions.$inferSelect, "id" | "version" | "fieldsJson">
		>,
		totalRows: number,
	) {
		type QuestionAccumulator = {
			field: FormField;
			answered: number;
			distribution: Record<string, number>;
			ratingSum: number;
			ratingCount: number;
		};
		const sortedVersions = [...versions].sort((a, b) => a.version - b.version);
		const versionStats = new Map<
			string,
			{
				version: (typeof versions)[number];
				fields: FormField[];
				questions: Map<string, QuestionAccumulator>;
				responseCount: number;
			}
		>();
		for (const version of sortedVersions) {
			const fields = parseFields(version.fieldsJson);
			versionStats.set(version.id, {
				version,
				fields,
				questions: new Map(
					fields.map((field) => [
						field.id,
						{
							field,
							answered: 0,
							distribution: {},
							ratingSum: 0,
							ratingCount: 0,
						},
					]),
				),
				responseCount: 0,
			});
		}

		let offset = 0;
		while (offset < totalRows) {
			const rows = await this.db
				.select({
					versionId: formResponses.versionId,
					answersJson: formResponses.answersJson,
				})
				.from(formResponses)
				.where(eq(formResponses.formId, formId))
				.orderBy(asc(formResponses.createdAt), asc(formResponses.id))
				.limit(responseStatsChunkSize)
				.offset(offset);
			if (!rows.length) break;
			offset += rows.length;
			for (const row of rows) {
				const stats = versionStats.get(row.versionId);
				if (!stats) continue;
				stats.responseCount += 1;
				const answers = JSON.parse(row.answersJson) as Record<string, unknown>;
				for (const field of stats.fields) {
					const value = answers[field.id];
					if (
						value === undefined ||
						value === "" ||
						(Array.isArray(value) && value.length === 0)
					)
						continue;
					const question = stats.questions.get(field.id)!;
					if (field.type === "singlechoice" || field.type === "multichoice") {
						question.answered += 1;
						for (const choice of new Set(
							(Array.isArray(value) ? value : [value]).map(String),
						))
							question.distribution[choice] =
								(question.distribution[choice] ?? 0) + 1;
					} else if (field.type === "rating") {
						const rating = Number(value);
						if (Number.isFinite(rating)) {
							question.ratingCount += 1;
							question.ratingSum += rating;
							question.distribution[String(rating)] =
								(question.distribution[String(rating)] ?? 0) + 1;
						}
					} else {
						question.answered += 1;
					}
				}
			}
			if (rows.length < responseStatsChunkSize) break;
		}

		return sortedVersions.map((version) => {
			const stats = versionStats.get(version.id)!;
			const questions = stats.fields.map((field) => {
				const question = stats.questions.get(field.id)!;
				if (field.type === "singlechoice" || field.type === "multichoice")
					return {
						fieldId: field.id,
						label: field.label,
						type: field.type,
						options: field.options ?? [],
						answered: question.answered,
						distribution: question.distribution,
					};
				if (field.type === "rating")
					return {
						fieldId: field.id,
						label: field.label,
						type: field.type,
						distribution: question.distribution,
						average: question.ratingCount
							? question.ratingSum / question.ratingCount
							: null,
					};
				return {
					fieldId: field.id,
					label: field.label,
					type: field.type,
					answered: question.answered,
				};
			});
			return {
				versionId: version.id,
				version: version.version,
				responseCount: stats.responseCount,
				questions,
			};
		});
	}

	private async getPublishedVersion(id: string) {
		const [version] = await this.db
			.select()
			.from(formVersions)
			.where(
				and(
					eq(formVersions.formId, id),
					isNotNull(formVersions.publishedAt),
					eq(
						formVersions.version,
						sql`(select max("latest"."version") from "form_versions" as "latest" where "latest"."form_id" = ${formVersions.formId} and "latest"."published_at" is not null)`,
					),
				),
			)
			.limit(1);
		return version ? publishedVersionDto(version) : null;
	}

	private async getLatestPublishedVersionsForForms(formIds: string[]) {
		const versions = await this.db
			.select({
				formId: formVersions.formId,
				id: formVersions.id,
				version: formVersions.version,
				title: formVersions.title,
				description: formVersions.description,
				confirmationMessage: formVersions.confirmationMessage,
				fieldsJson: formVersions.fieldsJson,
				accent: formVersions.accent,
				respondentAccess: formVersions.respondentAccess,
				publishedAt: formVersions.publishedAt,
			})
			.from(formVersions)
			.where(
				and(
					inArray(formVersions.formId, formIds),
					isNotNull(formVersions.publishedAt),
					eq(
						formVersions.version,
						sql`(select max("latest"."version") from "form_versions" as "latest" where "latest"."form_id" = ${formVersions.formId} and "latest"."published_at" is not null)`,
					),
				),
			);
		return new Map(
			versions.map((version) => [version.formId, publishedVersionDto(version)]),
		);
	}

	private async getDraftState(ownerId: string, id: string) {
		if (!(await this.getOwnedFormId(ownerId, id))) return null;
		const [draftVersion] = await this.db
			.select()
			.from(formVersions)
			.where(eq(formVersions.formId, id))
			.orderBy(desc(formVersions.version))
			.limit(1);
		return {
			draft: draftVersion
				? {
						title: draftVersion.title,
						description: draftVersion.description ?? "",
						accent: draftVersion.accent,
						confirmationMessage: draftVersion.confirmationMessage ?? "",
						fields: parseFields(draftVersion.fieldsJson),
					}
				: null,
			revision: draftVersion?.version ?? 0,
		};
	}

	private async getOwnedFormId(ownerId: string, id: string) {
		if (id.includes("\0")) return null;
		const [form] = await this.db
			.select({ id: forms.id })
			.from(forms)
			.where(
				and(
					eq(forms.id, id),
					eq(forms.ownerId, ownerId),
					isNull(forms.disabledAt),
				),
			)
			.limit(1);
		return form?.id ?? null;
	}

	private async getLimits() {
		const [limits] = await this.db
			.select()
			.from(formLimits)
			.where(eq(formLimits.id, 1))
			.limit(1);
		return {
			maxPublished: limits?.maxPublished ?? 25,
			maxMonthlyResponses: limits?.maxMonthlyResponses ?? maxResponsesPerMonth,
			maxRetainedResponses:
				limits?.maxRetainedResponses ?? maxRetainedResponses,
		};
	}
}

export class FormsError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		message = code,
	) {
		super(message);
	}
}

export function validateDefinition(value: FormDefinition): FormDefinition {
	if (!value || typeof value !== "object")
		throw new FormsError("INVALID_FORM", 400);
	const title = value.title?.trim();
	if (!title || title.length > 120 || title.includes("\0"))
		throw new FormsError("INVALID_TITLE", 400);
	const description = value.description?.trim();
	if (description?.includes("\0"))
		throw new FormsError("INVALID_DESCRIPTION", 400);
	if (description && description.length > 1000)
		throw new FormsError("INVALID_DESCRIPTION", 400);
	const confirmationMessage = value.confirmationMessage?.slice(0, 500) ?? "";
	if (confirmationMessage.includes("\0"))
		throw new FormsError("INVALID_FORM", 400);
	if (!formAccentIds.includes(value.accent))
		throw new FormsError("INVALID_ACCENT", 400);
	if (!Array.isArray(value.fields) || value.fields.length > maxFormFields)
		throw new FormsError("INVALID_FIELDS", 400);
	const ids = new Set<string>();
	const fields = value.fields.map((field) => {
		if (!field || !/^[a-zA-Z0-9_-]{1,64}$/.test(field.id) || ids.has(field.id))
			throw new FormsError("INVALID_FIELD_ID", 400);
		ids.add(field.id);
		if (
			!formFieldTypes.includes(field.type) ||
			!field.label?.trim() ||
			field.label.length > 160 ||
			(field.help?.length ?? 0) > 500
		)
			throw new FormsError("INVALID_FIELD", 400);
		const options = field.options?.map((item) => item.trim()).filter(Boolean);
		if (
			(field.type === "singlechoice" || field.type === "multichoice") &&
			(!options?.length ||
				options.length > 100 ||
				options.some((item) => item.length > 160))
		)
			throw new FormsError("INVALID_OPTIONS", 400);
		return {
			id: field.id,
			type: field.type,
			label: field.label.trim(),
			help: field.help?.trim() ?? "",
			required: Boolean(field.required),
			...(field.type === "singlechoice" || field.type === "multichoice"
				? { options }
				: {}),
		};
	});
	return {
		title,
		description,
		accent: value.accent,
		confirmationMessage,
		fields,
	};
}

function parseFields(json: string): FormField[] {
	try {
		return JSON.parse(json) as FormField[];
	} catch {
		return [];
	}
}

function publishedVersionDto(version: {
	id: string;
	version: number;
	title: string;
	description: string | null;
	confirmationMessage: string | null;
	fieldsJson: string;
	accent: string;
	respondentAccess: string;
	publishedAt: number | null;
}) {
	return {
		id: version.id,
		version: version.version,
		title: version.title,
		description: version.description ?? "",
		confirmationMessage: version.confirmationMessage ?? "",
		fields: parseFields(version.fieldsJson),
		accent: version.accent,
		respondentAccess: version.respondentAccess as RespondentAccessMode,
		publishedAt: version.publishedAt,
	};
}

function encodeFormsListCursor(cursor: FormsListCursor): string {
	const bytes = new TextEncoder().encode(JSON.stringify(cursor));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function decodeFormsListCursor(value: string): FormsListCursor {
	try {
		const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
		const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
		const bytes = Uint8Array.from(binary, (character) =>
			character.charCodeAt(0),
		);
		const cursor = JSON.parse(
			new TextDecoder().decode(bytes),
		) as Partial<FormsListCursor>;
		if (
			!Number.isSafeInteger(cursor.updatedAt) ||
			typeof cursor.id !== "string" ||
			!cursor.id ||
			cursor.id.includes("\0") ||
			typeof cursor.search !== "string"
		)
			throw new Error("Malformed forms list cursor");
		return cursor as FormsListCursor;
	} catch {
		throw new FormsError("INVALID_CURSOR", 400);
	}
}

function errorText(error: unknown): string {
	let current: unknown = error;
	const seen = new Set<unknown>();
	let result = "";
	while (current && !seen.has(current)) {
		seen.add(current);
		result += ` ${current instanceof Error ? current.message : String(current)}`;
		current =
			typeof current === "object" && "cause" in current
				? (current as { cause?: unknown }).cause
				: null;
	}
	return result;
}

function pgCode(error: unknown): string | null {
	let current: unknown = error;
	const seen = new Set<unknown>();
	while (current && !seen.has(current)) {
		seen.add(current);
		if (typeof current === "object" && "code" in current) {
			const code = (current as { code?: unknown }).code;
			if (typeof code === "string") return code;
		}
		current =
			typeof current === "object" && "cause" in current
				? (current as { cause?: unknown }).cause
				: null;
	}
	return null;
}

function pgConstraint(error: unknown): string | null {
	let current: unknown = error;
	const seen = new Set<unknown>();
	while (current && !seen.has(current)) {
		seen.add(current);
		if (typeof current === "object" && "constraint" in current) {
			const constraint = (current as { constraint?: unknown }).constraint;
			if (typeof constraint === "string") return constraint;
		}
		current =
			typeof current === "object" && "cause" in current
				? (current as { cause?: unknown }).cause
				: null;
	}
	return null;
}
