import {
	createFormsAuth,
	type FormsAuthEnv,
	formsAreEnabled,
} from "@urlx/api/modules/forms/auth";
import {
	FormsError,
	FormsService,
} from "@urlx/api/modules/forms/forms.service";
import { formTemplateDraft } from "@urlx/api/modules/forms/forms.templates";
import type { FormFieldDto } from "@urlx/api/modules/forms/forms.types";
import { createDb } from "@urlx/db";
import { Hono, type Context as HonoContext } from "hono";

type FormsBindings = FormsAuthEnv & {
	CORS_ORIGIN?: string;
	SHORT_URL_BASE?: string;
};
export const formsApp = new Hono<{ Bindings: FormsBindings }>();
type FormsContext = HonoContext<{ Bindings: FormsBindings }>;
const maxFormsBodyBytes = 64 * 1024;
const localRateCounters = new Map<string, { minute: number; count: number }>();

formsApp.use("/api/*", async (c, next) => {
	const length = Number(c.req.header("content-length"));
	if (Number.isFinite(length) && length > maxFormsBodyBytes)
		return bodyTooLarge(c);
	const body = c.req.raw.clone().body;
	if (body) {
		const reader = body.getReader();
		let bytes = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > maxFormsBodyBytes) {
					void reader.cancel().catch(() => undefined);
					return bodyTooLarge(c);
				}
			}
		} finally {
			reader.releaseLock();
		}
	}
	await next();
	c.header("Cache-Control", "no-store");
});

formsApp.all("/api/auth/*", async (c) => {
	const auth = tryCreateAuth(c.env);
	if (!auth) return c.json({ error: "FORMS_UNAVAILABLE" }, 503);
	return auth.handler(c.req.raw);
});

formsApp.get("/api/forms", async (c) => {
	const owner = await getOwner(c);
	if (owner instanceof Response) return owner;
	const result = await new FormsService(createDb(c.env.DB)).list(owner.id);
	return c.json({
		...result,
		usage: { ...result.usage, forms: result.forms.length },
	});
});

formsApp.post("/api/forms", async (c) => {
	const owner = await getOwner(c);
	if (owner instanceof Response) return owner;
	try {
		const body = await c.req.json<{ template?: string; title?: string }>();
		const form = await new FormsService(createDb(c.env.DB)).create(
			owner.id,
			formTemplateDraft(body.template ?? "blank", body.title),
		);
		return c.json(
			{ form: form?.form, draft: form?.draft, revision: form?.revision },
			201,
		);
	} catch (error) {
		return errorResponse(c, error);
	}
});

formsApp.get("/api/forms/:id", async (c) => {
	const owner = await getOwner(c);
	if (owner instanceof Response) return owner;
	const result = await new FormsService(createDb(c.env.DB)).get(
		owner.id,
		c.req.param("id"),
	);
	return result ? c.json(result) : c.json({ error: "FORM_NOT_FOUND" }, 404);
});

async function saveDraft(c: FormsContext) {
	const owner = await getOwner(c);
	if (owner instanceof Response) return owner;
	try {
		const body = await c.req.json<{
			draft?: Record<string, unknown>;
			revision?: number;
		}>();
		const saved = await new FormsService(createDb(c.env.DB)).save(
			owner.id,
			c.req.param("id") ?? "",
			(body.draft ?? body) as never,
			body.revision,
		);
		if (!saved) return c.json({ error: "FORM_NOT_FOUND" }, 404);
		return c.json({ draft: saved.draft, revision: saved.revision });
	} catch (error) {
		return errorResponse(c, error);
	}
}
formsApp.put("/api/forms/:id/draft", saveDraft);
formsApp.put("/api/forms/:id", saveDraft);

formsApp.post("/api/forms/:id/publish", async (c) => {
	const owner = await getOwner(c);
	if (owner instanceof Response) return owner;
	try {
		const body = await c.req
			.json<{ slug?: string; respondentAccess?: string }>()
			.catch(() => ({}) as { slug?: string; respondentAccess?: string });
		const service = new FormsService(createDb(c.env.DB));
		const result = await service.publish(
			owner.id,
			c.req.param("id"),
			body.slug,
			c.env.CORS_ORIGIN ?? c.env.BETTER_AUTH_URL ?? "",
			c.env.SHORT_URL_BASE ?? c.env.CORS_ORIGIN ?? "",
			body.respondentAccess as "public" | "verified_email",
		);
		return result
			? c.json({
					form: result.form,
					version: result.version,
					url: result.url,
					shortUrl: result.shortUrl,
				})
			: c.json({ error: "FORM_NOT_FOUND" }, 404);
	} catch (error) {
		return errorResponse(c, error);
	}
});

formsApp.post("/api/forms/:id/slug", async (c) => {
	const owner = await getOwner(c);
	if (owner instanceof Response) return owner;
	try {
		const body = await c.req.json<{ slug?: string }>();
		const result = await new FormsService(createDb(c.env.DB)).setSlug(
			owner.id,
			c.req.param("id"),
			body.slug ?? "",
			c.env.CORS_ORIGIN ?? c.env.BETTER_AUTH_URL ?? "",
			c.env.SHORT_URL_BASE ?? c.env.CORS_ORIGIN ?? "",
		);
		return result ? c.json(result) : c.json({ error: "FORM_NOT_FOUND" }, 404);
	} catch (error) {
		return errorResponse(c, error);
	}
});

formsApp.get("/api/forms/:id/responses", async (c) => {
	const owner = await getOwner(c);
	if (owner instanceof Response) return owner;
	const result = await new FormsService(createDb(c.env.DB)).responses(
		owner.id,
		c.req.param("id"),
		boundedInt(c.req.query("limit"), 500, 1, 1000),
		boundedInt(c.req.query("offset"), 0, 0, 1_000_000),
	);
	return result ? c.json(result) : c.json({ error: "FORM_NOT_FOUND" }, 404);
});

formsApp.delete("/api/forms/:id/responses/:responseId", async (c) => {
	const owner = await getOwner(c);
	if (owner instanceof Response) return owner;
	const result = await new FormsService(createDb(c.env.DB)).deleteResponse(
		owner.id,
		c.req.param("id"),
		c.req.param("responseId"),
	);
	return result ? c.json(result) : c.json({ error: "FORM_NOT_FOUND" }, 404);
});

formsApp.delete("/api/forms/:id/responses", async (c) => {
	const owner = await getOwner(c);
	if (owner instanceof Response) return owner;
	const result = await new FormsService(createDb(c.env.DB)).deleteResponse(
		owner.id,
		c.req.param("id"),
	);
	return result ? c.json(result) : c.json({ error: "FORM_NOT_FOUND" }, 404);
});

formsApp.get("/api/forms/:id/export.csv", async (c) => {
	const owner = await getOwner(c);
	if (owner instanceof Response) return owner;
	const rows = await new FormsService(createDb(c.env.DB)).exportRows(
		owner.id,
		c.req.param("id"),
	);
	if (!rows) return c.json({ error: "FORM_NOT_FOUND" }, 404);
	const columns = new Map<
		string,
		{ versionId: string; fieldId: string; heading: string }
	>();
	for (const row of rows)
		for (const field of row.fields)
			columns.set(`${row.versionId}:${field.id}`, {
				versionId: row.versionId,
				fieldId: field.id,
				heading: `v${row.version} · ${field.label}`,
			});
	const headers = [
		"response_id",
		"version",
		"submitted_at",
		...columns.values().map((column) => column.heading),
	];
	const csv = [
		headers.map(csvCell).join(","),
		...rows.map((row) =>
			[
				row.id,
				String(row.version ?? ""),
				new Date(row.createdAt).toISOString(),
				...[...columns.values()].map((column) =>
					column.versionId === row.versionId
						? answerText(row.answers[column.fieldId])
						: "",
				),
			]
				.map(csvCell)
				.join(","),
		),
	].join("\r\n");
	return new Response(csv, {
		headers: {
			"Content-Type": "text/csv; charset=utf-8",
			"Content-Disposition": `attachment; filename="form-${c.req.param("id")}-responses.csv"`,
			"Cache-Control": "no-store",
		},
	});
});

formsApp.delete("/api/forms/:id", async (c) => {
	const owner = await getOwner(c);
	if (owner instanceof Response) return owner;
	const deleted = await new FormsService(createDb(c.env.DB)).delete(
		owner.id,
		c.req.param("id"),
	);
	return deleted
		? c.json({ success: true })
		: c.json({ error: "FORM_NOT_FOUND" }, 404);
});

formsApp.get("/api/forms/public/:slug", async (c) => {
	if (!formsAreEnabled(c.env))
		return c.json({ error: "FORMS_UNAVAILABLE" }, 503);
	if (!(await allowFormRequest(c.env, requestIp(c), "render")))
		return rateLimited(c);
	const slug = c.req.param("slug").toLowerCase();
	const found = await new FormsService(createDb(c.env.DB)).getPublic(slug);
	if (!found)
		return c.json({ error: "FORM_NOT_FOUND" }, 404, {
			"Cache-Control": "no-store",
		});
	const respondentAccess = found.version.respondentAccess;
	const requiresSignIn =
		respondentAccess === "verified_email" && !(await getVerifiedRespondent(c));
	if (requiresSignIn) {
		return c.json(
			{
				form: {
					id: found.form.id,
					title: found.version.title,
					description: found.version.description,
					theme: found.form.theme,
					accent: found.version.accent,
					slug: found.canonicalSlug,
					canonicalSlug: found.canonicalSlug,
				},
				version: { id: found.version.id, fields: [] },
				requiresSignIn: true,
				respondentAccess,
			},
			200,
			{ "Cache-Control": "no-store" },
		);
	}
	const idempotencyKey = crypto.randomUUID();
	const submissionToken = await issueSubmissionToken(c.env, {
		formId: found.form.id,
		versionId: found.version.id,
		slug,
		idempotencyKey,
		expiresAt: Date.now() + 60 * 60_000,
	});
	return c.json(
		{
			form: {
				id: found.form.id,
				title: found.version.title,
				description: found.version.description,
				theme: found.form.theme,
				accent: found.version.accent,
				confirmationMessage: found.version.confirmationMessage,
				slug: found.canonicalSlug,
				canonicalSlug: found.canonicalSlug,
			},
			version: { id: found.version.id, fields: found.version.fields },
			submissionToken,
			idempotencyKey,
			requiresSignIn: false,
			respondentAccess,
		},
		200,
		{ "Cache-Control": "no-store" },
	);
});

formsApp.post("/api/forms/public/:slug/submit", async (c) => {
	if (!formsAreEnabled(c.env))
		return c.json({ error: "FORMS_UNAVAILABLE" }, 503);
	if (!(await allowFormRequest(c.env, requestIp(c), "submit")))
		return rateLimited(c);
	let found: Awaited<ReturnType<FormsService["getPublic"]>> = null;
	let tokenVersionForError: Awaited<ReturnType<FormsService["getVersion"]>> =
		null;
	let body: SubmissionBody = { answers: {} };
	try {
		const slug = c.req.param("slug").toLowerCase();
		const service = new FormsService(createDb(c.env.DB));
		found = await service.getPublic(slug);
		if (!found) throw new FormsError("FORM_NOT_FOUND", 404);
		if (
			found.version.respondentAccess === "verified_email" &&
			!(await getVerifiedRespondent(c))
		)
			throw new FormsError("SIGN_IN_REQUIRED", 401);
		body = await readSubmissionBody(c.req.raw);
		const token = await verifySubmissionToken(
			c.env,
			body.submissionToken ?? "",
		);
		if (
			!token ||
			token.slug !== slug ||
			token.expiresAt < Date.now() ||
			!body.versionId ||
			body.versionId !== token.versionId
		)
			throw new FormsError("INVALID_SUBMISSION_TOKEN", 403);
		if (body.honeypot)
			return successResponse(c, slug, { responseId: "", duplicate: false });
		if (found.form.id !== token.formId)
			throw new FormsError("FORM_NOT_FOUND", 404);
		const version = await service.getVersion(found.form.id, token.versionId);
		if (!version) throw new FormsError("FORM_VERSION_CLOSED", 409);
		tokenVersionForError = version;
		const values = validateAnswers(version.fields, body.answers);
		const key = (
			body.idempotencyKey ??
			c.req.header("Idempotency-Key") ??
			""
		).slice(0, 128);
		if (!key || key !== token.idempotencyKey)
			throw new FormsError("INVALID_SUBMISSION_KEY", 403);
		const result = await service.acceptResponse(
			found.form.id,
			version.id,
			key,
			values,
		);
		return successResponse(c, slug, result);
	} catch (error) {
		if (
			error instanceof FormsError &&
			error.status === 422 &&
			!(c.req.header("accept") ?? "").includes("application/json") &&
			found
		) {
			const version = tokenVersionForError ?? found.version;
			return htmlValidationError(
				c,
				found.form,
				version.fields,
				body,
				error.message,
			);
		}
		if (error instanceof FormsError)
			return c.json(
				{ error: error.code, message: error.message },
				error.status as 400,
				{ "Cache-Control": "no-store" },
			);
		return c.json({ error: "SUBMISSION_FAILED" }, 500);
	}
});

async function getOwner(c: FormsContext) {
	const auth = tryCreateAuth(c.env);
	if (!auth) return c.json({ error: "FORMS_UNAVAILABLE" }, 503);
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session) return c.json({ error: "UNAUTHORIZED" }, 401);
	return session.user;
}
function tryCreateAuth(env: FormsAuthEnv) {
	try {
		return createFormsAuth(env);
	} catch {
		return null;
	}
}
async function getVerifiedRespondent(c: FormsContext) {
	const auth = tryCreateAuth(c.env);
	if (!auth) return null;
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	return session?.user.emailVerified ? session.user : null;
}
function errorResponse(c: FormsContext, error: unknown) {
	if (error instanceof FormsError) {
		if (error.code === "REVISION_CONFLICT")
			return c.json(
				{ error: error.code, ...(safeJson(error.message) as object) },
				409,
			);
		return c.json(
			{ error: error.code, message: error.message },
			error.status as 400,
		);
	}
	return c.json({ error: "REQUEST_FAILED" }, 500);
}

type TokenPayload = {
	formId: string;
	versionId: string;
	slug: string;
	idempotencyKey: string;
	expiresAt: number;
};
type SubmissionBody = {
	versionId?: string;
	submissionToken?: string;
	idempotencyKey?: string;
	honeypot?: string;
	answers: Record<string, unknown>;
};
async function issueSubmissionToken(env: FormsAuthEnv, payload: TokenPayload) {
	const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
	return `${encoded}.${base64Url(await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(encoded)))}`;
}
async function verifySubmissionToken(
	env: FormsAuthEnv,
	token: string,
): Promise<TokenPayload | null> {
	const [encoded, signature, extra] = token.split(".");
	if (!encoded || !signature || extra) return null;
	try {
		const valid = await crypto.subtle.verify(
			"HMAC",
			await hmacKey(env),
			fromBase64Url(signature),
			new TextEncoder().encode(encoded),
		);
		return valid
			? (JSON.parse(
					new TextDecoder().decode(fromBase64Url(encoded)),
				) as TokenPayload)
			: null;
	} catch {
		return null;
	}
}
async function hmacKey(env: FormsAuthEnv) {
	if (!env.BETTER_AUTH_SECRET) throw new Error("FORMS_AUTH_UNAVAILABLE");
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(env.BETTER_AUTH_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

async function readSubmissionBody(request: Request): Promise<SubmissionBody> {
	if (
		(request.headers.get("content-type") ?? "").includes("application/json")
	) {
		const body = (await request.json()) as Record<string, unknown>;
		return {
			versionId: str(body.versionId),
			submissionToken: str(body.submissionToken),
			idempotencyKey: str(body.idempotencyKey),
			honeypot: str(body.honeypot ?? body.website),
			answers: objectAnswers(body.answers),
		};
	}
	const data = await request.formData();
	const answers: Record<string, unknown> = {};
	for (const [key, value] of data.entries()) {
		const match =
			/^answers\[([^\]]+)\](?:\[\])?$/.exec(key) ??
			/^answers\[([^\]]+)\]\[\]$/.exec(key);
		if (!match || typeof value !== "string") continue;
		const fieldId = match[1]!;
		if (key.endsWith("[]"))
			answers[fieldId] = [
				...(Array.isArray(answers[fieldId])
					? (answers[fieldId] as string[])
					: []),
				value,
			];
		else answers[fieldId] = value;
	}
	return {
		versionId: str(data.get("versionId")),
		submissionToken: str(data.get("submissionToken")),
		idempotencyKey: str(data.get("idempotencyKey")),
		honeypot: str(data.get("website") ?? data.get("honeypot")),
		answers,
	};
}

function validateAnswers(
	fields: FormFieldDto[],
	answers: Record<string, unknown>,
) {
	const output: Record<string, string | number | string[]> = {};
	for (const field of fields) {
		const raw = answers[field.id];
		if (field.type === "multichoice") {
			const values = (
				Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
			).map(String);
			if (field.required && !values.length)
				throw new FormsError(
					"FIELD_REQUIRED",
					422,
					`${field.label} is required`,
				);
			if (values.some((value) => !field.options?.includes(value)))
				throw new FormsError(
					"INVALID_OPTION",
					422,
					`${field.label} has an invalid option`,
				);
			output[field.id] = values;
			continue;
		}
		const value = raw === undefined || raw === null ? "" : String(raw).trim();
		if (!value && field.required)
			throw new FormsError("FIELD_REQUIRED", 422, `${field.label} is required`);
		if (value.length > 5000)
			throw new FormsError("FIELD_TOO_LONG", 422, `${field.label} is too long`);
		if (
			value &&
			field.type === "email" &&
			!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
		)
			throw new FormsError(
				"INVALID_EMAIL",
				422,
				`${field.label} must be a valid email`,
			);
		if (value && field.type === "phone" && !/^\+?[0-9 ()-]{5,32}$/.test(value))
			throw new FormsError(
				"INVALID_PHONE",
				422,
				`${field.label} must be a valid phone number`,
			);
		if (value && field.type === "date" && !isValidDate(value))
			throw new FormsError(
				"INVALID_DATE",
				422,
				`${field.label} must be a valid date`,
			);
		if (value && field.type === "number") {
			const number = Number(value);
			if (!Number.isFinite(number))
				throw new FormsError(
					"INVALID_NUMBER",
					422,
					`${field.label} must be a number`,
				);
			output[field.id] = number;
			continue;
		}
		if (value && field.type === "rating") {
			const number = Number(value);
			if (!Number.isInteger(number) || number < 1 || number > 5)
				throw new FormsError(
					"INVALID_RATING",
					422,
					`${field.label} must be between 1 and 5`,
				);
			output[field.id] = number;
			continue;
		}
		if (
			value &&
			field.type === "singlechoice" &&
			!field.options?.includes(value)
		)
			throw new FormsError(
				"INVALID_OPTION",
				422,
				`${field.label} has an invalid option`,
			);
		if (field.type !== "number" && field.type !== "rating")
			output[field.id] = value;
	}
	return output;
}

function isValidDate(value: string) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (year < 1 || month < 1 || month > 12 || day < 1) return false;
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [
		31,
		leapYear ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];
	return day <= daysInMonth[month - 1]!;
}

function htmlValidationError(
	c: FormsContext,
	form: { title: string },
	fields: FormFieldDto[],
	body: SubmissionBody,
	message: string,
) {
	const field = fields.find((item) => message.startsWith(item.label));
	const controls = fields
		.map((item) => {
			const value = body.answers[item.id];
			const error = field?.id === item.id ? message : "";
			const id = `field-${escapeHtml(item.id)}`;
			const label = `<label for="${id}">${escapeHtml(item.label)}${item.required ? " *" : ""}</label>`;
			const described = error
				? `aria-invalid="true" aria-describedby="${id}-error"`
				: "";
			const errorNode = error
				? `<p id="${id}-error" role="alert">${escapeHtml(error)}</p>`
				: "";
			const values = Array.isArray(value)
				? value.map(String)
				: value === undefined
					? []
					: [String(value)];
			if (item.type === "singlechoice" || item.type === "multichoice")
				return `<fieldset><legend>${escapeHtml(item.label)}${item.required ? " *" : ""}</legend>${(item.options ?? []).map((option, i) => `<label><input type="${item.type === "singlechoice" ? "radio" : "checkbox"}" name="answers[${escapeHtml(item.id)}]${item.type === "multichoice" ? "[]" : ""}" value="${escapeHtml(option)}" ${values.includes(option) ? "checked" : ""} ${item.type === "singlechoice" && item.required && i === 0 ? "required" : ""}>${escapeHtml(option)}</label>`).join("")}${errorNode}</fieldset>`;
			if (item.type === "paragraph")
				return `<div>${label}<textarea id="${id}" name="answers[${escapeHtml(item.id)}]" ${item.required ? "required" : ""} ${described}>${escapeHtml(values[0] ?? "")}</textarea>${errorNode}</div>`;
			const type =
				item.type === "email"
					? "email"
					: item.type === "phone"
						? "tel"
						: item.type === "number" || item.type === "rating"
							? "number"
							: item.type === "date"
								? "date"
								: "text";
			const range = item.type === "rating" ? 'min="1" max="5"' : "";
			return `<div>${label}<input id="${id}" name="answers[${escapeHtml(item.id)}]" type="${type}" value="${escapeHtml(values[0] ?? "")}" ${range} ${item.required ? "required" : ""} ${described}>${item.help ? `<small>${escapeHtml(item.help)}</small>` : ""}${errorNode}</div>`;
		})
		.join("");
	const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Check your answers · ${escapeHtml(form.title)}</title><main><h1>Check your answers</h1><p role="alert">${escapeHtml(message)}</p><form method="post" action="${escapeHtml(c.req.path)}"><input type="hidden" name="versionId" value="${escapeHtml(body.versionId ?? "")}"><input type="hidden" name="submissionToken" value="${escapeHtml(body.submissionToken ?? "")}"><input type="hidden" name="idempotencyKey" value="${escapeHtml(body.idempotencyKey ?? "")}"><div style="position:absolute;left:-10000px" aria-hidden="true"><label>Leave empty<input name="website" tabindex="-1" autocomplete="off"></label></div>${controls}<button type="submit">Submit</button></form></main></html>`;
	return c.html(html, 422, { "Cache-Control": "no-store" });
}

function successResponse(
	c: FormsContext,
	slug: string,
	data: { responseId: string; duplicate: boolean },
) {
	if ((c.req.header("accept") ?? "").includes("application/json"))
		return c.json({ success: true, ...data }, 200, {
			"Cache-Control": "no-store",
		});
	return c.redirect(`/f/${encodeURIComponent(slug)}?submitted=1`, 303);
}
function str(value: unknown) {
	return typeof value === "string" ? value : "";
}
function objectAnswers(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function boundedInt(
	raw: string | undefined,
	fallback: number,
	min: number,
	max: number,
) {
	const value = Number(raw);
	return Number.isInteger(value)
		? Math.max(min, Math.min(max, value))
		: fallback;
}
function bodyTooLarge(c: FormsContext) {
	return (c.req.header("accept") ?? "").includes("text/html")
		? c.html(
				'<!doctype html><meta charset="utf-8"><title>Request too large</title><main><h1>Submission too large</h1><p>Please keep your form response under 64 KiB and try again.</p></main>',
				413,
				{ "Cache-Control": "no-store" },
			)
		: c.json({ error: "PAYLOAD_TOO_LARGE", maxBytes: maxFormsBodyBytes }, 413, {
				"Cache-Control": "no-store",
			});
}
function rateLimited(c: FormsContext) {
	return c.json({ error: "RATE_LIMITED" }, 429, {
		"Cache-Control": "no-store",
		"Retry-After": "60",
	});
}
function requestIp(c: FormsContext) {
	const cloudflareIp = c.req.header("cf-connecting-ip");
	if (cloudflareIp) return cloudflareIp;
	if (c.env.FORMS_RENDER_RATE_LIMIT || c.env.FORMS_SUBMIT_RATE_LIMIT)
		return "unknown-edge-client";
	return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}
async function allowFormRequest(
	env: FormsBindings,
	ip: string,
	kind: "render" | "submit",
) {
	const binding =
		kind === "render"
			? env.FORMS_RENDER_RATE_LIMIT
			: env.FORMS_SUBMIT_RATE_LIMIT;
	const key = `forms:${kind}:${ip.slice(0, 128)}`;
	if (binding) {
		try {
			return (await binding.limit({ key })).success;
		} catch {
			return false;
		}
	}
	return localFormRateLimit(key, kind === "render" ? 30 : 10);
}
export function localFormRateLimit(
	key: string,
	maximum: number,
	now = Date.now(),
) {
	const minute = Math.floor(now / 60_000);
	for (const [candidate, value] of localRateCounters)
		if (minute - value.minute > 2) localRateCounters.delete(candidate);
	if (localRateCounters.size > 4096) {
		for (const candidate of localRateCounters.keys()) {
			localRateCounters.delete(candidate);
			if (localRateCounters.size <= 2048) break;
		}
	}
	const current = localRateCounters.get(key);
	if (!current || current.minute !== minute) {
		localRateCounters.set(key, { minute, count: 1 });
		return true;
	}
	if (current.count >= maximum) return false;
	current.count += 1;
	return true;
}
function answerText(value: unknown) {
	return Array.isArray(value) ? value.join("; ") : String(value ?? "");
}
function csvCell(value: string) {
	let firstVisible = 0;
	while (firstVisible < value.length && value.charCodeAt(firstVisible) <= 0x20)
		firstVisible += 1;
	const safe = "=+@-".includes(value[firstVisible] ?? "\0")
		? `'${value}`
		: value;
	return `"${safe.replace(/"/g, '""')}"`;
}
function escapeHtml(value: string) {
	return value.replace(
		/[&<>"']/g,
		(char) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				char
			] ?? char,
	);
}
function safeJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}
function base64Url(bytes: Uint8Array | ArrayBuffer) {
	const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	for (const byte of data) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}
function fromBase64Url(value: string) {
	const binary = atob(
		value
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(value.length / 4) * 4, "="),
	);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
