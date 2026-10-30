import { timingSafeEqual } from "node:crypto";
import { lookup as systemLookup } from "node:dns/promises";
import {
	createServer as createHttpServer,
	request as httpRequest,
} from "node:http";
import { isIP, connect as tcpConnect } from "node:net";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";
import {
	isUnsafePublicIpv4Address,
	isUnsafeRequestUrl,
} from "../apps/conversion-renderer/src/network-safety.ts";

const maxHeaderBytes = 16 * 1024;
const maxRequestBytes = 1024 * 1024;
const maxResponseBytes = 4 * 1024 * 1024;
const maxTunnelBytes = 16 * 1024 * 1024;
const requestTimeoutMs = 20_000;
const tunnelTimeoutMs = 35_000;

export function hostIpv4Addresses() {
	const addresses = new Set();
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4") addresses.add(entry.address);
			if (entry.family === "IPv6") addresses.add(entry.address.toLowerCase());
		}
	}
	return addresses;
}

export async function resolvePublicIpv4(hostname, options = {}) {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (!normalized || isUnsafeRequestUrl(`http://${normalized}/`)) return null;
	let addresses;
	if (isIP(normalized) === 4) {
		addresses = [{ address: normalized, family: 4 }];
	} else if (isIP(normalized) !== 0) {
		return null;
	} else {
		let timer;
		try {
			const pending = options.lookup
				? options.lookup(normalized)
				: systemLookup(normalized, { all: true, verbatim: true });
			addresses = await Promise.race([
				pending,
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error("DNS timeout")), 3_000);
				}),
			]);
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}
	if (!addresses.length) return null;
	const localAddresses = options.hostAddresses ?? hostIpv4Addresses();
	const publicIpv4 = [];
	for (const result of addresses) {
		const normalizedAddress = result.address
			.toLowerCase()
			.replace(/^\[|\]$/g, "");
		if (result.family === 6) {
			if (
				isUnsafeRequestUrl(`http://[${normalizedAddress}]/`) ||
				localAddresses.has(normalizedAddress)
			)
				return null;
			// The local proxy dials vetted IPv4 records only. Public IPv6 records
			// are safe to ignore; private/reserved IPv6 records still fail closed.
			continue;
		}
		if (
			result.family !== 4 ||
			isIP(normalizedAddress) !== 4 ||
			isUnsafePublicIpv4Address(normalizedAddress) ||
			localAddresses.has(normalizedAddress)
		)
			return null;
		publicIpv4.push(normalizedAddress);
	}
	return publicIpv4[0] ?? null;
}

export function createLocalPublicProxy(options) {
	if (typeof options.token !== "string" || options.token.length < 32)
		throw new Error("Local proxy token is too short");
	const expectedAuthorization = Buffer.from(
		`Basic ${Buffer.from(`urlx-local:${options.token}`).toString("base64")}`,
	);
	const sockets = new Set();
	const dial =
		options.connect ?? ((address, port) => tcpConnect({ host: address, port }));
	const resolveHost = (hostname) => resolvePublicIpv4(hostname, options);
	const makeHttpRequest = options.httpRequest ?? httpRequest;
	const server = createHttpServer({ maxHeaderSize: maxHeaderBytes });
	server.headersTimeout = 10_000;
	server.requestTimeout = requestTimeoutMs;
	server.keepAliveTimeout = 5_000;
	server.maxRequestsPerSocket = 8;
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.on(
		"request",
		(request, response) => void forwardHttp(request, response),
	);
	server.on(
		"connect",
		(request, client, head) => void createTunnel(request, client, head),
	);

	function authorized(request) {
		const actual = request.headers["proxy-authorization"];
		if (typeof actual !== "string") return false;
		const bytes = Buffer.from(actual);
		return (
			bytes.length === expectedAuthorization.length &&
			timingSafeEqual(bytes, expectedAuthorization)
		);
	}

	function rejectProxy(response) {
		response.writeHead(407, {
			"Proxy-Authenticate": 'Basic realm="URLX local preview"',
			Connection: "close",
			"Cache-Control": "no-store",
		});
		response.end();
	}

	async function forwardHttp(request, response) {
		if (!authorized(request)) return rejectProxy(response);
		if (
			!new Set(["GET", "HEAD", "POST", "OPTIONS"]).has(request.method ?? "")
		) {
			response.writeHead(405, { Connection: "close" });
			response.end();
			return;
		}
		let target;
		try {
			target = new URL(request.url ?? "");
		} catch {
			response.writeHead(400, { Connection: "close" });
			response.end();
			return;
		}
		const authority = target.host.toLowerCase();
		if (
			target.protocol !== "http:" ||
			target.username ||
			target.password ||
			Number(target.port || 80) !== 80 ||
			isUnsafeRequestUrl(target.toString()) ||
			request.headers.host?.toLowerCase() !== authority
		) {
			response.writeHead(403, { Connection: "close" });
			response.end();
			return;
		}
		const address = await resolveHost(target.hostname);
		if (request.aborted || request.socket.destroyed || response.destroyed) return;
		if (!address) {
			response.writeHead(403, { Connection: "close" });
			response.end();
			return;
		}
		const contentLength = Number(request.headers["content-length"] ?? 0);
		if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
			response.writeHead(413, { Connection: "close" });
			response.end();
			return;
		}
		const headers = stripProxyHeaders(request.headers);
		headers.host = authority;
		let received = 0;
		let sent = 0;
		let finished = false;
		let upstream;
		const timer = setTimeout(
			() => upstream?.destroy(new Error("proxy request timed out")),
			requestTimeoutMs,
		);
		const pinnedLookup = (_hostname, lookupOptions, callback) => {
			if (lookupOptions?.all) callback(null, [{ address, family: 4 }]);
			else callback(null, address, 4);
		};
		const close = () => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			upstream?.destroy();
		};
		upstream = makeHttpRequest({
			hostname: target.hostname,
			port: 80,
			method: request.method,
			path: `${target.pathname}${target.search}`,
			headers,
			lookup: pinnedLookup,
			agent: false,
		});
		request.on("data", (chunk) => {
			received += chunk.length;
			if (received > maxRequestBytes) {
				response.destroy();
				close();
			}
		});
		request.on("error", close);
		request.on("aborted", close);
		response.on("error", close);
		response.on("close", close);
		upstream.on("response", (upstreamResponse) => {
			const upstreamLength = Number(
				upstreamResponse.headers["content-length"] ?? 0,
			);
			if (
				Number.isFinite(upstreamLength) &&
				upstreamLength > maxResponseBytes
			) {
				upstreamResponse.destroy();
				response.writeHead(502, { Connection: "close" });
				response.end();
				close();
				return;
			}
			const responseHeaders = stripProxyHeaders(upstreamResponse.headers);
			responseHeaders.connection = "close";
			response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
			upstreamResponse.on("data", (chunk) => {
				sent += chunk.length;
				if (sent > maxResponseBytes) {
					upstreamResponse.destroy();
					response.destroy();
					close();
				}
			});
			upstreamResponse.on("error", close);
			upstreamResponse.pipe(response);
			upstreamResponse.once("end", () => {
				finished = true;
				clearTimeout(timer);
			});
		});
		upstream.on("error", () => {
			if (!response.headersSent) {
				response.writeHead(502, { Connection: "close" });
				response.end();
			}
			close();
		});
		request.pipe(upstream);
	}

	async function createTunnel(request, client, head) {
		if (!authorized(request)) {
			client.end(
				'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="URLX local preview"\r\nConnection: close\r\n\r\n',
			);
			return;
		}
		const match = /^([a-zA-Z0-9.-]+):443$/.exec(request.url ?? "");
		const hostname = match?.[1] ?? "";
		const authority = `${hostname.toLowerCase()}:443`;
		if (
			!hostname ||
			request.headers.host?.toLowerCase() !== authority ||
			isUnsafeRequestUrl(`https://${hostname}/`)
		) {
			client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		const address = await resolveHost(hostname);
		if (client.destroyed) return;
		if (!address) {
			client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		const upstream = dial(address, 443);
		let connected = false;
		let transferred = 0;
		const totalTimer = setTimeout(() => stop(), tunnelTimeoutMs);
		const stop = () => {
			clearTimeout(totalTimer);
			client.destroy();
			upstream.destroy();
		};
		upstream.setTimeout(tunnelTimeoutMs, stop);
		client.once("error", stop);
		upstream.once("error", () => {
			if (!connected)
				client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
			else stop();
		});
		upstream.once("connect", () => {
			if (client.destroyed) return stop();
			connected = true;
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			client.on("error", stop);
			upstream.on("error", stop);
			client.on("data", countBytes);
			upstream.on("data", countBytes);
			client.pipe(upstream);
			upstream.pipe(client);
		});
		client.once("close", stop);
		function countBytes(chunk) {
			transferred += chunk.length;
			if (transferred > maxTunnelBytes) stop();
		}
	}

	return {
		server,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

function stripProxyHeaders(headers) {
	const connectionTokens = (headers.connection ?? "")
		.split(",")
		.map((value) => value.trim().toLowerCase());
	const stripped = new Set([
		"connection",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"proxy-connection",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade",
		...connectionTokens,
	]);
	return Object.fromEntries(
		Object.entries(headers).filter(
			([name, value]) =>
				!stripped.has(name.toLowerCase()) && value !== undefined,
		),
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	if (
		process.env.NODE_ENV !== "development" ||
		process.env.URLX_LOCAL_PREVIEW !== "true"
	)
		throw new Error(
			"Local public proxy requires explicit development preview mode",
		);
	const token = process.env.URLX_LOCAL_PROXY_TOKEN;
	if (!token) throw new Error("Missing native preview proxy token");
	const proxy = createLocalPublicProxy({ token });
	proxy.server.listen(8789, "127.0.0.1", () =>
		console.info("Native local public proxy listening on 127.0.0.1:8789"),
	);
	const shutdown = async () => {
		await proxy.close().catch(() => undefined);
		process.exit(0);
	};
	process.once("SIGINT", () => void shutdown());
	process.once("SIGTERM", () => void shutdown());
}
