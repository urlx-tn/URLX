const signalExitCodes = {
	SIGINT: 128 + 2,
	SIGTERM: 128 + 15,
} as const;

export async function runWebCommand(
	command: string[],
	spawnCommand: typeof Bun.spawn = Bun.spawn,
) {
	if (command.length === 0) {
		throw new Error("A web command is required after the egress policy check");
	}

	let child: ReturnType<typeof Bun.spawn> | undefined;
	const pendingSignals: Array<"SIGINT" | "SIGTERM"> = [];
	const forwardSignal = (signal: "SIGINT" | "SIGTERM") => {
		if (!child) {
			pendingSignals.push(signal);
			return;
		}
		if (!child.killed) child.kill(signal);
	};
	const forwardInterrupt = () => forwardSignal("SIGINT");
	const forwardTermination = () => forwardSignal("SIGTERM");
	process.on("SIGINT", forwardInterrupt);
	process.on("SIGTERM", forwardTermination);

	try {
		const runningChild = spawnCommand(command, {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		child = runningChild;
		for (const signal of pendingSignals) forwardSignal(signal);

		const exitCode = await runningChild.exited;
		if (runningChild.signalCode === "SIGINT") return signalExitCodes.SIGINT;
		if (runningChild.signalCode === "SIGTERM") return signalExitCodes.SIGTERM;
		return exitCode;
	} finally {
		process.off("SIGINT", forwardInterrupt);
		process.off("SIGTERM", forwardTermination);
	}
}

export async function startUrlxWeb(
	command: string[],
	checkPolicy: () => Promise<unknown> = async () => {
		await import("./check-egress-policy.ts");
	},
) {
	await checkPolicy();
	return runWebCommand(command);
}

if (import.meta.main) {
	try {
		process.exitCode = await startUrlxWeb(process.argv.slice(2));
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	}
}
