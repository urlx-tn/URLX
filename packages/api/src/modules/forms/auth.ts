import {
	authAccount,
	authSession,
	authUser,
	authVerification,
	createDb,
} from "@urlx/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { Resend } from "resend";

export type FormsAuthEnv = {
	DB: D1Database;
	FORMS_RENDER_RATE_LIMIT?: FormsRateLimitBinding;
	FORMS_SUBMIT_RATE_LIMIT?: FormsRateLimitBinding;
	FORMS_ENABLED?: boolean | string;
	BETTER_AUTH_SECRET?: string;
	BETTER_AUTH_URL?: string;
	RESEND_API_KEY?: string;
	AUTH_EMAIL_FROM?: string;
};

export type FormsRateLimitBinding = {
	limit(input: { key: string }): Promise<{ success: boolean }>;
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

export function createFormsAuth(env: FormsAuthEnv) {
	if (
		!formsAreEnabled(env) ||
		!env.BETTER_AUTH_SECRET ||
		!env.BETTER_AUTH_URL ||
		!env.RESEND_API_KEY ||
		!env.AUTH_EMAIL_FROM
	) {
		throw new Error("FORMS_AUTH_UNAVAILABLE");
	}
	const resend = new Resend(env.RESEND_API_KEY);
	const db = createDb(env.DB);
	return betterAuth({
		appName: "URLX Forms",
		baseURL: env.BETTER_AUTH_URL,
		secret: env.BETTER_AUTH_SECRET,
		database: drizzleAdapter(db, {
			provider: "sqlite",
			schema: {
				user: authUser,
				session: authSession,
				account: authAccount,
				verification: authVerification,
			},
		}),
		emailAndPassword: { enabled: false },
		plugins: [
			magicLink({
				expiresIn: 10 * 60,
				storeToken: "hashed",
				sendMagicLink: async ({ email, url }) => {
					const result = await resend.emails.send({
						from: env.AUTH_EMAIL_FROM!,
						to: email,
						subject: "Your URLX Forms sign-in link",
						html: `<p>Use this link to sign in to URLX Forms. It expires in 10 minutes.</p><p><a href="${escapeHtml(url)}">Sign in to URLX Forms</a></p>`,
					});
					if (result.error) throw new Error("MAGIC_LINK_DELIVERY_FAILED");
				},
			}),
		],
		advanced: {
			cookiePrefix: "urlx-forms",
			useSecureCookies: env.BETTER_AUTH_URL.startsWith("https://"),
		},
	});
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
