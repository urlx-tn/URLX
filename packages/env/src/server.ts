import { lookup } from "node:dns/promises";
import { readFile, readlink } from "node:fs/promises";
import { connect, isIP } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { z } from "zod";

const emptyAsUndefined = (value: unknown) => (value === "" ? undefined : value);

const nonEmptyOptional = z.preprocess(
	emptyAsUndefined,
	z.string().min(1).optional(),
);
const placeholderAuthSecret =
	/^(?:change[\s_-]*me|please[\s_-]*change[\s_-]*me|your[\s_-]*secret(?:[\s_-]*here)?|replace[\s_-]*me|insert[\s_-]*secret(?:[\s_-]*here)?|example(?:[\s_-]*secret)?|development(?:[\s_-]*secret)?|test(?:[\s_-]*secret)?|password|secret)$/i;
const postgresUrl = z
	.string()
	.url()
	.refine((value) => /^postgres(?:ql)?:$/.test(new URL(value).protocol), {
		message: "Expected a PostgreSQL connection URL",
	});
const valkeyUrl = z
	.string()
	.url()
	.refine((value) => ["redis:", "rediss:"].includes(new URL(value).protocol), {
		message: "Expected a Valkey/Redis connection URL",
	});
const visitorKey = z.string().refine((value) => {
	if (
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			value,
		)
	)
		return false;
	const decoded = Buffer.from(value, "base64");
	return decoded.byteLength === 32 && decoded.toString("base64") === value;
}, "Expected canonical base64 encoding of a 32-byte visitor-token key");
const originUrl = z
	.string()
	.url()
	.refine((value) => {
		const url = new URL(value);
		return (
			(url.protocol === "https:" || url.protocol === "http:") &&
			url.origin === value
		);
	}, "Expected an HTTP(S) origin without a path");
const port = (fallback: number) =>
	z.coerce.number().int().min(1).max(65_535).default(fallback);

export const apiServerEnvSchema = z
	.object({
		DATABASE_URL: postgresUrl,
		PG_POOL_MAX: z.preprocess(
			emptyAsUndefined,
			z.coerce.number().int().min(1).max(100).default(10),
		),
		VALKEY_URL: valkeyUrl,
		VISITOR_TOKEN_KEY_BASE64: visitorKey,
		CORS_ORIGIN: originUrl,
		SHORT_URL_BASE: z.preprocess(emptyAsUndefined, z.string().url().optional()),
		EGRESS_PROXY_URL: z.string().url(),
		EGRESS_POLICY_READY_FILE: z.string().min(1),
		FORMS_ENABLED: z.enum(["true", "false"]).default("false"),
		BETTER_AUTH_SECRET: nonEmptyOptional,
		BETTER_AUTH_URL: z.preprocess(
			emptyAsUndefined,
			z.string().url().optional(),
		),
		RESEND_API_KEY: nonEmptyOptional,
		AUTH_EMAIL_FROM: nonEmptyOptional,
		PORT: port(8787),
	})
	.superRefine((value, ctx) => {
		if (value.FORMS_ENABLED !== "true") return;
		for (const name of [
			"BETTER_AUTH_SECRET",
			"BETTER_AUTH_URL",
			"RESEND_API_KEY",
			"AUTH_EMAIL_FROM",
		] as const) {
			if (!value[name]) {
				ctx.addIssue({
					code: "custom",
					path: [name],
					message: `${name} is required when FORMS_ENABLED=true`,
				});
			}
		}
		const secret = value.BETTER_AUTH_SECRET;
		if (secret && new TextEncoder().encode(secret).byteLength < 32) {
			ctx.addIssue({
				code: "custom",
				path: ["BETTER_AUTH_SECRET"],
				message: "BETTER_AUTH_SECRET must be at least 32 bytes",
			});
		}
		if (
			secret &&
			(placeholderAuthSecret.test(secret.trim()) ||
				/^(.)\1{31,}$/su.test(secret))
		) {
			ctx.addIssue({
				code: "custom",
				path: ["BETTER_AUTH_SECRET"],
				message: "BETTER_AUTH_SECRET must not be a placeholder value",
			});
		}
	});

export const conversionServerEnvSchema = z
	.object({
		VALKEY_URL: valkeyUrl,
		VISITOR_TOKEN_KEY_BASE64: visitorKey,
		CORS_ORIGIN: originUrl,
		BROWSER_RENDERER_URL: z.string().url().optional(),
		CONVERSION_BROWSER_DISABLED: z.enum(["true", "false"]).default("false"),
		EGRESS_POLICY_READY_FILE: z.string().min(1),
		PORT: port(8788),
	})
	.superRefine((env, context) => {
		if (
			env.CONVERSION_BROWSER_DISABLED !== "true" &&
			!env.BROWSER_RENDERER_URL
		) {
			context.addIssue({
				code: "custom",
				path: ["BROWSER_RENDERER_URL"],
				message:
					"BROWSER_RENDERER_URL is required unless browser conversion is disabled",
			});
		}
	});

export const browserRendererEnvSchema = z.object({
	EGRESS_PROXY_URL: z.string().url(),
	EGRESS_POLICY_READY_FILE: z.string().min(1),
	PORT: port(3100),
	RENDERER_CONCURRENCY: z.preprocess(
		emptyAsUndefined,
		z.coerce.number().int().min(1).max(8).default(2),
	),
	RENDERER_MAX_QUEUE: z.preprocess(
		emptyAsUndefined,
		z.coerce.number().int().min(0).max(32).default(8),
	),
	RENDERER_QUEUE_TIMEOUT_MS: z.preprocess(
		emptyAsUndefined,
		z.coerce.number().int().min(100).max(30_000).default(5_000),
	),
});

export const migratorEnvSchema = z.object({
	MIGRATOR_DATABASE_URL: postgresUrl,
});

export type ApiServerEnv = z.infer<typeof apiServerEnvSchema>;
export type ConversionServerEnv = z.infer<typeof conversionServerEnvSchema>;
export type BrowserRendererEnv = z.infer<typeof browserRendererEnvSchema>;
export type MigratorEnv = z.infer<typeof migratorEnvSchema>;

export function parseApiServerEnv(source: Record<string, string | undefined>) {
	return apiServerEnvSchema.parse(source);
}

export function parseConversionServerEnv(
	source: Record<string, string | undefined>,
) {
	return conversionServerEnvSchema.parse(source);
}

export function parseBrowserRendererEnv(
	source: Record<string, string | undefined>,
) {
	return browserRendererEnvSchema.parse(source);
}

export function parseMigratorEnv(source: Record<string, string | undefined>) {
	return migratorEnvSchema.parse(source);
}

type EgressServiceName = "api" | "conversion" | "conversion-renderer" | "web";

type EgressPolicyManifest = {
	policyVersion: 1;
	verifiedAt: string;
	ruleSetHash: string;
	hostAddresses: string[];
	proxy: {
		containerId: string;
		networks: Array<{ networkId: string; ip: string }>;
	};
	services: Record<
		EgressServiceName,
		| {
				containerId: string;
				netns: string;
				networks: Array<{ networkId: string; ip: string }>;
		  }
		| undefined
	>;
};

/**
 * A renderer/API process must not become ready until the host policy manifest
 * matches its current container identity and network addresses.
 */
export async function verifyEgressPolicyReadyFile(
	path: string,
	serviceName: EgressServiceName,
	options: {
		now?: number;
		maxAgeMs?: number;
		containerHostname?: string;
		currentNetns?: string;
		currentIps?: string[];
		proxyAddresses?: string[];
		checkProxy?: boolean;
	} = {},
) {
	let manifest: EgressPolicyManifest;
	try {
		manifest = JSON.parse(await readFile(path, "utf8")) as EgressPolicyManifest;
	} catch {
		throw new Error("Egress policy readiness manifest is missing or invalid");
	}
	if (
		manifest.policyVersion !== 1 ||
		!/^([a-f0-9]{64})$/i.test(manifest.ruleSetHash) ||
		!Array.isArray(manifest.hostAddresses) ||
		manifest.hostAddresses.length === 0 ||
		manifest.hostAddresses.some((address) => isIP(address) === 0) ||
		!manifest.proxy?.containerId ||
		!/^[a-f0-9]{64}$/i.test(manifest.proxy.containerId) ||
		!Array.isArray(manifest.proxy.networks) ||
		manifest.proxy.networks.length === 0
	) {
		throw new Error("Egress policy readiness manifest has an invalid shape");
	}
	const verifiedAt = Date.parse(manifest.verifiedAt);
	const now = options.now ?? Date.now();
	const maxAgeMs = options.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
	if (
		!Number.isFinite(verifiedAt) ||
		verifiedAt > now + 60_000 ||
		now - verifiedAt > maxAgeMs
	) {
		throw new Error("Egress policy readiness manifest is stale");
	}
	if (
		manifest.proxy.networks.some(
			(network) =>
				!/^([a-f0-9]{64})$/i.test(network.networkId) || isIP(network.ip) === 0,
		)
	) {
		throw new Error(
			"Egress policy readiness manifest contains invalid addresses",
		);
	}
	const service = manifest.services?.[serviceName];
	if (
		!service?.containerId ||
		!/^[a-f0-9]{64}$/i.test(service.containerId) ||
		!/^net:\[\d+\]$/.test(service.netns) ||
		!Array.isArray(service.networks) ||
		service.networks.length === 0 ||
		service.networks.some(
			(network) =>
				!/^([a-f0-9]{64})$/i.test(network.networkId) || isIP(network.ip) === 0,
		)
	) {
		throw new Error(`Egress policy manifest has no entry for ${serviceName}`);
	}
	const serviceNetworkIds = new Set(
		service.networks.map((network) => network.networkId),
	);
	const sharedProxyIps = new Set(
		manifest.proxy.networks
			.filter((network) => serviceNetworkIds.has(network.networkId))
			.map((network) => network.ip),
	);
	if (sharedProxyIps.size === 0) {
		throw new Error(
			"Egress policy manifest does not attach this service to the proxy network",
		);
	}
	const containerHostname = (
		options.containerHostname ?? hostname()
	).toLowerCase();
	if (
		!/^[a-f0-9]{12,64}$/i.test(containerHostname) ||
		!service.containerId.toLowerCase().startsWith(containerHostname)
	) {
		throw new Error(
			"Egress policy manifest does not match this container identity",
		);
	}
	const currentNetns =
		options.currentNetns ?? (await readlink("/proc/self/ns/net"));
	if (!service.netns || service.netns !== currentNetns) {
		throw new Error(
			"Egress policy manifest does not match this network namespace",
		);
	}
	const expectedIps = service.networks
		.map((network) => network.ip)
		.filter((address) => !isLinkLocalIp(address))
		.sort();
	const currentIps = (
		options.currentIps ??
		Object.values(networkInterfaces())
			.flatMap((addresses) => addresses ?? [])
			.filter((address) => !address.internal && isIP(address.address) !== 0)
			.map((address) => address.address.split("%")[0] ?? address.address)
	)
		.filter((address) => !isLinkLocalIp(address))
		.sort();
	if (JSON.stringify(currentIps) !== JSON.stringify(expectedIps)) {
		throw new Error(
			"Egress policy manifest does not match this container network",
		);
	}
	const proxyResolved =
		options.proxyAddresses ??
		(await lookup("egress-proxy", { all: true }).catch(() => [])).map(
			(record) => record.address,
		);
	if (
		!proxyResolved.length ||
		proxyResolved.some((address) => !sharedProxyIps.has(address))
	) {
		throw new Error(
			"Egress proxy address does not match the verified policy manifest",
		);
	}
	if (options.checkProxy !== false && !(await isProxyReachable())) {
		throw new Error("Verified egress proxy is not accepting connections");
	}
	return manifest;
}

export async function waitForEgressPolicyReadyFile(
	path: string,
	serviceName: EgressServiceName,
	options: {
		timeoutMs?: number;
		pollIntervalMs?: number;
		verify?: typeof verifyEgressPolicyReadyFile;
	} = {},
) {
	const timeoutMs = options.timeoutMs ?? 300_000;
	const pollIntervalMs = options.pollIntervalMs ?? 1_000;
	const verify = options.verify ?? verifyEgressPolicyReadyFile;
	const startedAt = Date.now();
	let lastError: unknown;
	while (Date.now() - startedAt < timeoutMs) {
		try {
			return await verify(path, serviceName);
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}
	}
	const reason =
		lastError instanceof Error ? lastError.message : "unknown policy error";
	throw new Error(
		`Egress policy did not become ready for ${serviceName}: ${reason}`,
	);
}

function isLinkLocalIp(address: string) {
	if (address.startsWith("169.254.")) return true;
	return address.toLowerCase().startsWith("fe80:");
}

function isProxyReachable(timeoutMs = 1_000) {
	return new Promise<boolean>((resolve) => {
		const socket = connect({ host: "egress-proxy", port: 3128 });
		const timer = setTimeout(() => socket.destroy(), timeoutMs);
		const finish = (reachable: boolean) => {
			clearTimeout(timer);
			socket.destroy();
			resolve(reachable);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}
