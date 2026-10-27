import assert from "node:assert/strict";
import test from "node:test";
import { wrapRemoteCommand } from "./compose-test-support.mjs";

const command = `cd /root/urlx/test && docker compose --project-name urlx-container-validation --file compose.yaml exec -T api bun -e "$(printf '%s' 'YWJj' | base64 -d)"`;

test("remote command remains unprivileged by default and when false", () => {
	const originalValue = process.env.URLX_FORMS_E2E_SSH_SUDO;
	delete process.env.URLX_FORMS_E2E_SSH_SUDO;
	try {
		assert.equal(wrapRemoteCommand(command), command);
	} finally {
		if (originalValue === undefined) {
			delete process.env.URLX_FORMS_E2E_SSH_SUDO;
		} else {
			process.env.URLX_FORMS_E2E_SSH_SUDO = originalValue;
		}
	}
	assert.equal(wrapRemoteCommand(command, "false"), command);
});

test("true runs the entire remote command under noninteractive sudo", () => {
	assert.equal(
		wrapRemoteCommand(command, "true"),
		String.raw`sudo -n sh -c 'cd /root/urlx/test && docker compose --project-name urlx-container-validation --file compose.yaml exec -T api bun -e "$(printf '\''%s'\'' '\''YWJj'\'' | base64 -d)"'`,
	);
});

test("invalid sudo flags are rejected", () => {
	for (const value of ["1", "yes", "True", "", "false "]) {
		assert.throws(
			() => wrapRemoteCommand(command, value),
			/URLX_FORMS_E2E_SSH_SUDO must be exactly "true" or "false"/,
		);
	}
});
