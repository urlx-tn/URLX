import {
	createServer as createHttpServer,
	request as httpRequest,
} from "node:http";
import {
	connect as connectTcp,
	createServer as createNetServer,
} from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	createLocalPublicProxy,
	resolvePublicIpv4,
} from "../../../scripts/local-public-proxy.mjs";

const publicAddress = "93.184.216.34";
const localAddresses = new Set();
const auth = `Basic ${Buffer.from("urlx-local:" + "a".repeat(64)).toString("base64")}`;
const servers = [];
const proxies = [];

afterEach(async () => {
	await Promise.all(
		proxies.splice(0).map((proxy) => proxy.close().catch(() => undefined)),
	);
	await Promise.all(
		servers
			.splice(0)
			.map((server) => new Promise((resolve) => server.close(() => resolve()))),
	);
});

describe("native preview public-only proxy", () => {
	it("rejects mixed public/private answers, host-owned IPs, and IPv6 literals", async () => {
		expect(
			await resolvePublicIpv4("dual-stack.example", {
				hostAddresses: localAddresses,
				lookup: async () => [
					{ address: "2606:4700:4700::1111", family: 6 },
					{ address: publicAddress, family: 4 },
				],
			}),
		).toBe(publicAddress);
		expect(
			await resolvePublicIpv4("rebinding.example", {
				hostAddresses: localAddresses,
				lookup: async () => [
					{ address: publicAddress, family: 4 },
					{ address: "10.0.0.9", family: 4 },
				],
			}),
		).toBeNull();
		expect(
			await resolvePublicIpv4("owned.example", {
				hostAddresses: new Set([publicAddress]),
				lookup: async () => [{ address: publicAddress, family: 4 }],
			}),
		).toBeNull();
		expect(
			await resolvePublicIpv4("v6-only.example", {
				hostAddresses: localAddresses,
				lookup: async () => [{ address: "2001:4860:4860::8888", family: 6 }],
			}),
		).toBeNull();
	});

	it("rejects unauthenticated, private, mismatched Host, and unsupported CONNECT targets", async () => {
		const proxy = createLocalPublicProxy({
			token: "a".repeat(64),
			hostAddresses: localAddresses,
			lookup: async () => [{ address: publicAddress, family: 4 }],
		});
		proxies.push(proxy);
		await listen(proxy.server);
		const port = proxy.server.address().port;
		expect((await proxyGet(port, "http://example.com/", {})).status).toBe(407);
		expect(
			(
				await proxyGet(port, "http://127.0.0.1/admin", {
					"proxy-authorization": auth,
				})
			).status,
		).toBe(403);
		expect(
			(
				await proxyGet(port, "http://example.com/", {
					"proxy-authorization": auth,
					host: "attacker.example",
				})
			).status,
		).toBe(403);
		expect((await proxyConnect(port, "example.com:8443", auth)).status).toBe(
			403,
		);
		expect((await proxyConnect(port, "127.0.0.1:443", auth)).status).toBe(403);
		const connectChallenge = await proxyConnect(port, "example.com:443");
		expect(connectChallenge.status).toBe(407);
		expect(connectChallenge.headers).toContain(
			'Proxy-Authenticate: Basic realm="URLX local preview"',
		);
	});

	it("pins an authenticated CONNECT tunnel to one checked numeric IPv4 address", async () => {
		const upstream = createNetServer((socket) => socket.pipe(socket));
		servers.push(upstream);
		await listen(upstream);
		const upstreamPort = upstream.address().port;
		const dialed = [];
		const proxy = createLocalPublicProxy({
			token: "a".repeat(64),
			hostAddresses: localAddresses,
			lookup: async () => [{ address: publicAddress, family: 4 }],
			connect: (address, port) => {
				dialed.push({ address, port });
				return connectTcp(upstreamPort, "127.0.0.1");
			},
		});
		proxies.push(proxy);
		await listen(proxy.server);
		const client = connectTcp(proxy.server.address().port, "127.0.0.1");
		let buffered = "";
		const response = new Promise((resolve, reject) => {
			client.on("data", (chunk) => {
				buffered += chunk.toString();
				const end = buffered.indexOf("\r\n\r\n");
				if (end >= 0) resolve(buffered.slice(0, end));
			});
			client.once("error", reject);
		});
		client.write(
			`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: ${auth}\r\n\r\n`,
		);
		const headers = await response;
		expect(headers).toContain("200 Connection Established");
		expect(dialed).toEqual([{ address: publicAddress, port: 443 }]);
		client.destroy();
	});

	it("survives a client-aborted CONNECT and serves the next proxy request", async () => {
		const tunnelUpstream = createNetServer((socket) => socket.pipe(socket));
		servers.push(tunnelUpstream);
		await listen(tunnelUpstream);
		const httpUpstream = createHttpServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("proxy still alive");
		});
		servers.push(httpUpstream);
		await listen(httpUpstream);
		const proxy = createLocalPublicProxy({
			token: "a".repeat(64),
			hostAddresses: localAddresses,
			lookup: async () => [{ address: publicAddress, family: 4 }],
			connect: () => connectTcp(tunnelUpstream.address().port, "127.0.0.1"),
			httpRequest: (options) =>
				httpRequest({
					...options,
					hostname: "127.0.0.1",
					port: httpUpstream.address().port,
					lookup: (_hostname, _lookupOptions, callback) =>
						callback(null, "127.0.0.1", 4),
				}),
		});
		proxies.push(proxy);
		await listen(proxy.server);
		const client = connectTcp(proxy.server.address().port, "127.0.0.1");
		const established = new Promise((resolve, reject) => {
			let buffered = "";
			client.on("data", (chunk) => {
				buffered += chunk.toString();
				if (buffered.includes("\r\n\r\n")) resolve();
			});
			client.once("error", reject);
		});
		client.on("connect", () =>
			client.write(
				`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: ${auth}\r\n\r\n`,
			),
		);
		await established;
		client.destroy();
		await new Promise((resolve) => client.once("close", resolve));
		const response = await proxyGet(
			proxy.server.address().port,
			"http://example.com/after-abort",
			{ "proxy-authorization": auth },
		);
		expect(response.status).toBe(200);
		expect(response.body).toBe("proxy still alive");
	});

	it("pins absolute-form HTTP to the checked numeric IPv4 address", async () => {
		const upstream = createHttpServer((request, response) => {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end(`${request.headers.host}${request.url}`);
		});
		servers.push(upstream);
		await listen(upstream);
		const upstreamPort = upstream.address().port;
		const pinned = [];
		const proxy = createLocalPublicProxy({
			token: "a".repeat(64),
			hostAddresses: localAddresses,
			lookup: async () => [{ address: publicAddress, family: 4 }],
			httpRequest: (options) => {
				options.lookup(options.hostname, { all: false }, (error, address) => {
					if (error) throw error;
					pinned.push(address);
				});
				return httpRequest({
					...options,
					hostname: "127.0.0.1",
					port: upstreamPort,
					lookup: (_hostname, _lookupOptions, callback) =>
						callback(null, "127.0.0.1", 4),
				});
			},
		});
		proxies.push(proxy);
		await listen(proxy.server);
		const response = await proxyGet(
			proxy.server.address().port,
			"http://example.com/path",
			{ "proxy-authorization": auth },
		);
		expect(response.status).toBe(200);
		expect(response.body).toBe("example.com/path");
		expect(pinned).toEqual([publicAddress]);
	});

	it("does not start an upstream HTTP request after the client aborts during DNS", async () => {
		let signalLookup;
		const lookupStarted = new Promise((resolve) => {
			signalLookup = resolve;
		});
		let releaseLookup;
		const lookupResult = new Promise((resolve) => {
			releaseLookup = resolve;
		});
		let upstreamStarted = false;
		const proxy = createLocalPublicProxy({
			token: "a".repeat(64),
			hostAddresses: localAddresses,
			lookup: () => {
				signalLookup();
				return lookupResult;
			},
			httpRequest: () => {
				upstreamStarted = true;
				throw new Error("unexpected upstream request");
			},
		});
		proxies.push(proxy);
		await listen(proxy.server);
		const clientClosed = new Promise((resolve) =>
			proxy.server.once("connection", (socket) => socket.once("close", resolve)),
		);
		const request = httpRequest({
			hostname: "127.0.0.1",
			port: proxy.server.address().port,
			path: "http://example.com/abort",
			method: "GET",
			headers: {
				host: "example.com",
				"proxy-authorization": auth,
			},
		});
		request.on("error", () => undefined);
		request.end();
		await lookupStarted;
		request.destroy();
		await clientClosed;
		releaseLookup([{ address: publicAddress, family: 4 }]);
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(upstreamStarted).toBe(false);
	});
});

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
}

function proxyGet(port, target, headers) {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{
				hostname: "127.0.0.1",
				port,
				path: target,
				method: "GET",
				headers: { ...headers, host: headers.host ?? new URL(target).host },
			},
			(response) => {
				const chunks = [];
				response.setEncoding("utf8");
				response.on("data", (chunk) => chunks.push(chunk));
				response.once("end", () =>
					resolve({ status: response.statusCode, body: chunks.join("") }),
				);
			},
		);
		request.once("error", reject);
		request.end();
	});
}

function proxyConnect(port, authority, authorization) {
	return new Promise((resolve, reject) => {
		const client = connectTcp(port, "127.0.0.1");
		let data = "";
		client.on("connect", () => {
			client.write(
				`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ""}\r\n`,
			);
		});
		client.on("data", (chunk) => {
			data += chunk.toString();
			const match = /HTTP\/1\.1 (\d{3})/.exec(data);
			if (match && data.includes("\r\n\r\n")) {
				client.destroy();
				resolve({ status: Number(match[1]), headers: data });
			}
		});
		client.once("error", reject);
	});
}
