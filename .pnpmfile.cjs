module.exports = {
	hooks: {
		readPackage(pkg) {
			if (pkg.name !== "better-auth" || pkg.version !== "1.7.10") return pkg;

			const hasVitestPeer = Object.hasOwn(pkg.peerDependencies ?? {}, "vitest");
			const hasVitestPeerMeta = Object.hasOwn(
				pkg.peerDependenciesMeta ?? {},
				"vitest",
			);
			if (!hasVitestPeer && !hasVitestPeerMeta) return pkg;
			if (!hasVitestPeer || pkg.peerDependenciesMeta?.vitest?.optional !== true) {
				throw new Error(
					"Expected Better Auth 1.7.10 to declare Vitest only as an optional peer.",
				);
			}

			// pnpm 10.22 keeps a dev-provided optional peer in `deploy --prod`.
			delete pkg.peerDependencies.vitest;
			delete pkg.peerDependenciesMeta.vitest;
			return pkg;
		},
	},
};
