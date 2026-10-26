import type { APIRoute } from "astro";
import { proxyApiRequest } from "../../../lib/api-proxy";

export const prerender = false;

const handler: APIRoute = async ({ request, params }) => {
	return proxyApiRequest(request, `/api/forms/${params.path ?? ""}`);
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
