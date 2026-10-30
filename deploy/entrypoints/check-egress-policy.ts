import { waitForEgressPolicyReadyFile } from "@urlx/env/server";

const path = process.env.EGRESS_POLICY_READY_FILE;
if (!path) {
	throw new Error("EGRESS_POLICY_READY_FILE is required before web startup");
}

await waitForEgressPolicyReadyFile(path, "web");
