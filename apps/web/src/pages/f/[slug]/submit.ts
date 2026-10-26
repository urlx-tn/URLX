import type { APIRoute } from "astro";
import { proxyApiRequest } from "../../../lib/api-proxy";

export const prerender = false;

export const POST: APIRoute = ({ request, params }) => {
	const slug = encodeURIComponent(params.slug ?? "");
	return proxyApiRequest(request, `/api/forms/public/${slug}/submit`);
};
