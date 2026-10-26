import type { APIRoute } from "astro";
import { proxyApiRequest } from "../../../lib/api-proxy";

export const prerender = false;

const handler: APIRoute = ({ request, params }) =>
	proxyApiRequest(request, `/api/auth/${params.path ?? ""}`);

export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
