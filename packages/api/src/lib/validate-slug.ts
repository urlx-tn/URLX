const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const minSlugLength = 3;
const maxSlugLength = 30;

// Handles that must not be claimable as bio-page slugs because they collide
// with existing or likely web routes.
const reservedSlugs = new Set([
	"create",
	"privacy",
	"terms",
	"api",
	"api-reference",
	"rpc",
	"p",
	"admin",
	"about",
	"index",
	"new",
]);

export type SlugValidation =
	| { ok: true; slug: string }
	| { ok: false; reason: "INVALID_SLUG" | "RESERVED_SLUG" };

export function validateSlug(rawSlug: string): SlugValidation {
	const slug = rawSlug.trim().toLowerCase();

	if (
		slug.length < minSlugLength ||
		slug.length > maxSlugLength ||
		!slugPattern.test(slug)
	) {
		return { ok: false, reason: "INVALID_SLUG" };
	}

	if (reservedSlugs.has(slug)) {
		return { ok: false, reason: "RESERVED_SLUG" };
	}

	return { ok: true, slug };
}
