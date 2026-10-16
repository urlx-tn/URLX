import type { createDb } from "@urlx/db";
import {
	formAliases,
	formAliasTombstones,
	formLimits,
	formMonthlyUsage,
	formResponses,
	forms,
	formVersions,
} from "@urlx/db";
import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import { LinkService } from "../links/link.service";
import {
	type FormDefinitionDto,
	type FormFieldDto,
	formAccentIds,
	formFieldTypes,
} from "./forms.types";

export type FormsDb = ReturnType<typeof createDb>;
export type FormField = FormFieldDto;
export type FormDefinition = FormDefinitionDto;
export const maxFormFields = 50;
export const maxResponsesPerMonth = 1000;
export const maxRetainedResponses = 10000;

export class FormsService {
	constructor(
		private readonly db: FormsDb,
		private readonly now = () => Date.now(),
	) {}

	async list(ownerId: string) {
		const rows = await this.db
			.select()
			.from(forms)
			.where(and(eq(forms.ownerId, ownerId), isNull(forms.disabledAt)))
			.orderBy(desc(forms.updatedAt));
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
		return {
			forms: await Promise.all(
				rows.map(async (form) => ({
					...form,
					publishedVersion: await this.getPublishedVersion(form.id),
				})),
			),
			usage: {
				month,
				responses: usage?.responseCount ?? 0,
				monthlyLimit: limits.maxMonthlyResponses,
				publishedLimit: limits.maxPublished,
				retainedLimit: limits.maxRetainedResponses,
			},
		};
	}

	async get(ownerId: string, id: string) {
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
		return {
			form: { ...form, publishedVersion: await this.getPublishedVersion(id) },
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
			publishedVersion: await this.getPublishedVersion(id),
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
		await this.db.batch([
			this.db.insert(forms).values({
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
			}),
			this.db.insert(formVersions).values({
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
			}),
		]);
		return this.get(ownerId, formId);
	}

	async save(
		ownerId: string,
		id: string,
		definition: FormDefinition,
		revision?: number,
	) {
		const clean = validateDefinition(definition);
		const current = await this.get(ownerId, id);
		if (!current || !current.draft) return null;
		if (revision !== undefined && revision !== current.revision)
			throw new FormsError(
				"REVISION_CONFLICT",
				409,
				JSON.stringify({ draft: current.draft, revision: current.revision }),
			);
		const now = this.now();
		const nextVersion = current.revision + 1;
		await this.db.batch([
			this.db
				.update(forms)
				.set({
					title: clean.title,
					description: clean.description ?? null,
					accent: clean.accent,
					confirmationMessage: clean.confirmationMessage ?? null,
					updatedAt: now,
				})
				.where(and(eq(forms.id, id), eq(forms.ownerId, ownerId))),
			this.db.insert(formVersions).values({
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
			}),
		]);
		return this.get(ownerId, id);
	}

	async publish(
		ownerId: string,
		id: string,
		requestedSlug: string | undefined,
		publicBaseUrl: string,
		shortUrlBase: string,
	) {
		let current = await this.get(ownerId, id);
		if (!current || !current.draft) return null;
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
			const idSuffix = id.replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase();
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
		try {
			await this.db.batch([
				this.db
					.update(formVersions)
					.set({ publishedAt: now })
					.where(
						and(eq(formVersions.id, latest.id), eq(formVersions.formId, id)),
					),
				this.db
					.update(forms)
					.set({ updatedAt: now })
					.where(and(eq(forms.id, id), eq(forms.ownerId, ownerId))),
			]);
		} catch (error) {
			if (errorText(error).includes("forms_owner_published_limit"))
				throw new FormsError("PUBLISHED_FORM_LIMIT", 409);
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
					version: latest.id,
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
		const current = await this.get(ownerId, id);
		if (!current) return null;
		const [alias] = await this.db
			.select()
			.from(formAliases)
			.where(eq(formAliases.alias, slug))
			.limit(1);
		if (alias && alias.formId !== id) throw new FormsError("SLUG_TAKEN", 409);
		const [tombstone] = await this.db
			.select()
			.from(formAliasTombstones)
			.where(eq(formAliasTombstones.alias, slug))
			.limit(1);
		if (tombstone) throw new FormsError("SLUG_TAKEN", 409);
		if (!alias) {
			try {
				await this.db
					.insert(formAliases)
					.values({ alias: slug, formId: id, createdAt: this.now() });
			} catch (error) {
				const [conflict] = await this.db
					.select()
					.from(formAliases)
					.where(eq(formAliases.alias, slug))
					.limit(1);
				if (conflict && conflict.formId !== id)
					throw new FormsError("SLUG_TAKEN", 409);
				throw error;
			}
		}
		await this.db
			.update(forms)
			.set({ slug, updatedAt: this.now() })
			.where(and(eq(forms.id, id), eq(forms.ownerId, ownerId)));
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
		const current = await this.get(ownerId, id);
		if (!current) return false;
		const deleted = await this.db
			.delete(forms)
			.where(and(eq(forms.id, id), eq(forms.ownerId, ownerId)));
		return deleted.meta.changes > 0;
	}

	async getPublic(slug: string) {
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
		const existing = await this.db
			.select()
			.from(formResponses)
			.where(
				and(
					eq(formResponses.formId, formId),
					eq(formResponses.idempotencyKey, key),
				),
			)
			.limit(1);
		if (existing.length)
			return { responseId: existing[0]!.id, duplicate: true };
		const responseId = crypto.randomUUID();
		try {
			await this.db.insert(formResponses).values({
				id: responseId,
				formId,
				versionId,
				idempotencyKey: key,
				answersJson: JSON.stringify(answers),
				createdAt: this.now(),
			});
		} catch (error) {
			const retry = await this.db
				.select()
				.from(formResponses)
				.where(
					and(
						eq(formResponses.formId, formId),
						eq(formResponses.idempotencyKey, key),
					),
				)
				.limit(1);
			if (retry.length) return { responseId: retry[0]!.id, duplicate: true };
			if (errorText(error).includes("forms_owner_monthly_quota"))
				throw new FormsError("QUOTA_EXCEEDED", 429);
			if (
				errorText(error).includes("forms_collection_closed") ||
				errorText(error).includes("FOREIGN KEY constraint failed")
			)
				throw new FormsError("FORM_VERSION_CLOSED", 409);
			throw error;
		}
		return { responseId, duplicate: false };
	}

	async responses(ownerId: string, id: string, limit = 100, offset = 0) {
		if (!(await this.get(ownerId, id))) return null;
		const rows = await this.db
			.select()
			.from(formResponses)
			.where(eq(formResponses.formId, id))
			.orderBy(desc(formResponses.createdAt))
			.limit(limit)
			.offset(offset);
		const versions = await this.db
			.select()
			.from(formVersions)
			.where(eq(formVersions.formId, id));
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
		const [total] = await this.db
			.select({ total: count() })
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
		const stats = await this.responseStats(id, versions);
		return {
			responses,
			total: Number(total?.total ?? 0),
			offset,
			limit,
			usage: usage?.responseCount ?? 0,
			monthlyLimit: maxResponsesPerMonth,
			stats,
		};
	}

	async deleteResponse(ownerId: string, id: string, responseId?: string) {
		if (!(await this.get(ownerId, id))) return null;
		const deleted = responseId
			? await this.db
					.delete(formResponses)
					.where(
						and(eq(formResponses.formId, id), eq(formResponses.id, responseId)),
					)
			: await this.db.delete(formResponses).where(eq(formResponses.formId, id));
		return { success: true, deleted: deleted.meta.changes };
	}

	async exportRows(ownerId: string, id: string) {
		if (!(await this.get(ownerId, id))) return null;
		const rows = await this.db
			.select()
			.from(formResponses)
			.where(eq(formResponses.formId, id))
			.orderBy(asc(formResponses.createdAt));
		const versions = await this.db
			.select()
			.from(formVersions)
			.where(eq(formVersions.formId, id));
		const versionsById = new Map(
			versions.map((version) => [version.id, version]),
		);
		return rows.map((row) => ({
			...row,
			version: versionsById.get(row.versionId)?.version ?? null,
			fields: parseFields(versionsById.get(row.versionId)?.fieldsJson ?? "[]"),
			answers: JSON.parse(row.answersJson) as Record<string, unknown>,
		}));
	}

	private async responseStats(
		formId: string,
		versions: Array<typeof formVersions.$inferSelect>,
	) {
		const results = [];
		for (const version of versions.sort((a, b) => a.version - b.version)) {
			const rows = await this.db
				.select({ answersJson: formResponses.answersJson })
				.from(formResponses)
				.where(
					and(
						eq(formResponses.formId, formId),
						eq(formResponses.versionId, version.id),
					),
				);
			const fields = parseFields(version.fieldsJson);
			const questions = fields.map((field) => {
				const values = rows
					.map(
						(row) =>
							(JSON.parse(row.answersJson) as Record<string, unknown>)[
								field.id
							],
					)
					.filter((value) => value !== undefined && value !== "");
				if (field.type === "singlechoice" || field.type === "multichoice") {
					const distribution: Record<string, number> = {};
					for (const value of values)
						for (const choice of (Array.isArray(value) ? value : [value]).map(
							String,
						))
							distribution[choice] = (distribution[choice] ?? 0) + 1;
					return {
						fieldId: field.id,
						label: field.label,
						type: field.type,
						distribution,
					};
				}
				if (field.type === "rating") {
					const ratings = values.map(Number).filter(Number.isFinite);
					const distribution: Record<string, number> = {};
					for (const value of ratings)
						distribution[String(value)] =
							(distribution[String(value)] ?? 0) + 1;
					return {
						fieldId: field.id,
						label: field.label,
						type: field.type,
						distribution,
						average: ratings.length
							? ratings.reduce((sum, value) => sum + value, 0) / ratings.length
							: null,
					};
				}
				return {
					fieldId: field.id,
					label: field.label,
					type: field.type,
					answered: values.length,
				};
			});
			results.push({
				versionId: version.id,
				version: version.version,
				fields,
				responseCount: rows.length,
				questions,
			});
		}
		return results;
	}

	private async getPublishedVersion(id: string) {
		const [version] = await this.db
			.select()
			.from(formVersions)
			.where(
				and(
					eq(formVersions.formId, id),
					sql`${formVersions.publishedAt} is not null`,
				),
			)
			.orderBy(desc(formVersions.version))
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
					publishedAt: version.publishedAt,
				}
			: null;
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
	if (!title || title.length > 120) throw new FormsError("INVALID_TITLE", 400);
	const description = value.description?.trim();
	if (description && description.length > 1000)
		throw new FormsError("INVALID_DESCRIPTION", 400);
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
		confirmationMessage: value.confirmationMessage?.slice(0, 500) ?? "",
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
