import { formsAreEnabled } from "@urlx/api/modules/forms/auth";
import { FormsService } from "@urlx/api/modules/forms/forms.service";
import { Hono } from "hono";
import { renderFormOg } from "./forms-og/renderer";
import type { ApiAppBindings } from "./runtime/bindings";

type OgEnv = { Bindings: ApiAppBindings };
type WorkerCacheStorage = CacheStorage & { default?: Cache };

export const formsOgApp = new Hono<OgEnv>();

formsOgApp.get("/api/forms/public/:slug/og.png", async (c) => {
	if (!formsAreEnabled(c.env))
		return c.json({ error: "FORMS_UNAVAILABLE" }, 503);
	const slug = c.req.param("slug").toLowerCase();
	const service = new FormsService(c.env.DB);
	const found = await service.getPublic(slug);
	if (!found)
		return c.json({ error: "FORM_NOT_FOUND" }, 404, {
			"Cache-Control": "no-store",
		});

	const isSignInRequired = found.version.respondentAccess === "verified_email";
	const publicHeaders = {
		"Content-Type": "image/png",
		// This URL is shared by a form across access-mode changes. Keep the HTTP
		// response out of browser/CDN caches so an old public image cannot expose
		// labels after the owner requires sign-in.
		"Cache-Control": "no-store",
		ETag: `"${found.version.id}-${found.version.respondentAccess}"`,
		"X-Content-Type-Options": "nosniff",
	};
	const workerGlobals = globalThis as unknown as {
		caches?: WorkerCacheStorage;
	};
	const cache = workerGlobals.caches?.default;
	const cacheKey = new Request(
		`${new URL(c.req.url).origin}/__forms-og-cache/${encodeURIComponent(found.form.id)}/${encodeURIComponent(found.version.id)}/${found.version.respondentAccess}.png`,
	);
	if (cache) {
		try {
			const cached = await cache.match(cacheKey);
			if (cached)
				return new Response(cached.body, {
					status: 200,
					headers: publicHeaders,
				});
		} catch {
			// A cache miss or cache API error must not keep a published image offline.
		}
	}

	try {
		const png = await renderFormOg(
			{
				title: found.version.title,
				description: found.version.description,
				accent: found.version.accent,
			},
			isSignInRequired ? [] : found.version.fields,
		);
		const response = new Response(png, { status: 200, headers: publicHeaders });
		if (cache) {
			try {
				await cache.put(
					cacheKey,
					new Response(png, {
						status: 200,
						headers: {
							...publicHeaders,
							...(isSignInRequired
								? {}
								: { "Cache-Control": "public, max-age=31536000, immutable" }),
						},
					}),
				);
			} catch {
				// Rendering remains successful if this isolate cannot cache the image.
			}
		}
		return response;
	} catch (error) {
		const requestId = crypto.randomUUID();
		console.error("Unable to render form social image", {
			requestId,
			errorType:
				error instanceof Error &&
				/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(error.name)
					? error.name
					: "Error",
		});
		return c.json({ error: "OG_RENDER_FAILED", requestId }, 500, {
			"X-Request-ID": requestId,
			"Cache-Control": "no-store",
		});
	}
});
