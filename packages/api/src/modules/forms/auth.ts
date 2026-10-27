import type { UrlxDb } from "@urlx/db";
import { authAccount, authSession, authUser, authVerification } from "@urlx/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { magicLink } from "better-auth/plugins";
import { Resend } from "resend";

export type FormsAuthEnv = {
	FORMS_ENABLED?: boolean | string;
	BETTER_AUTH_SECRET?: string;
	BETTER_AUTH_URL?: string;
	RESEND_API_KEY?: string;
	AUTH_EMAIL_FROM?: string;
};

export type FormsAuthSecondaryStorage = {
	get(key: string): Promise<string | null>;
	getAndDelete(key: string): Promise<string | null>;
	increment(key: string, ttlSeconds: number): Promise<number>;
	set(
		key: string,
		value: string,
		ttlSeconds?: number,
	): Promise<string | void | null>;
	delete(key: string): Promise<string | void | null>;
};

export function formsAreEnabled(env: FormsAuthEnv) {
	return (
		(env.FORMS_ENABLED === true || env.FORMS_ENABLED === "true") &&
		Boolean(
			env.BETTER_AUTH_SECRET &&
				env.BETTER_AUTH_URL &&
				env.RESEND_API_KEY &&
				env.AUTH_EMAIL_FROM,
		)
	);
}

export function createFormsAuth(
	env: FormsAuthEnv,
	db: UrlxDb,
	secondaryStorage: FormsAuthSecondaryStorage,
) {
	if (
		!formsAreEnabled(env) ||
		!env.BETTER_AUTH_SECRET ||
		!env.BETTER_AUTH_URL ||
		!env.RESEND_API_KEY ||
		!env.AUTH_EMAIL_FROM
	) {
		throw new Error("FORMS_AUTH_UNAVAILABLE");
	}
	const emailFrom = env.AUTH_EMAIL_FROM;
	if (!emailFrom) throw new Error("FORMS_AUTH_UNAVAILABLE");
	const resend = new Resend(env.RESEND_API_KEY);
	return betterAuth({
		appName: "URLX Forms",
		baseURL: env.BETTER_AUTH_URL,
		secret: env.BETTER_AUTH_SECRET,
		secondaryStorage,
		rateLimit: { enabled: true, storage: "secondary-storage" },
		database: drizzleAdapter(db, {
			provider: "pg",
			schema: {
				user: authUser,
				session: authSession,
				account: authAccount,
				verification: authVerification,
			},
		}),
		emailAndPassword: { enabled: false },
		session: { storeSessionInDatabase: true },
		plugins: [
			magicLink({
				expiresIn: 10 * 60,
				storeToken: "hashed",
				sendMagicLink: async ({ email, url }) => {
					const result = await resend.emails.send({
						from: emailFrom,
						to: email,
						subject: "Your URLX Forms sign-in link",
						html: `<p>Use this link to sign in to URLX Forms. It expires in 10 minutes.</p><p><a href="${escapeHtml(url)}">Sign in to URLX Forms</a></p>`,
					});
					if (result.error) throw new Error("MAGIC_LINK_DELIVERY_FAILED");
				},
			}),
		],
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path === "/revoke-session") {
					if (containsNul(ctx.body.token)) {
						throw new APIError("BAD_REQUEST", {
							message: "Session token must not contain NUL characters",
						});
					}
					return;
				}
				if (ctx.path !== "/sign-in/magic-link" && ctx.path !== "/update-user")
					return;
				const { name, image } = ctx.body;
				if (containsNul(name) || containsNul(image)) {
					throw new APIError("BAD_REQUEST", {
						message: "Name and image must not contain NUL characters",
					});
				}
			}),
		},
		advanced: {
			cookiePrefix: "urlx-forms",
			ipAddress: { ipAddressHeaders: ["x-urlx-client-ip"] },
			useSecureCookies: env.BETTER_AUTH_URL.startsWith("https://"),
		},
	});
}

function containsNul(value: unknown): value is string {
	return typeof value === "string" && value.includes("\0");
}

function escapeHtml(value: string) {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				character
			] ?? character,
	);
}
