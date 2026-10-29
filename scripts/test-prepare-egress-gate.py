from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


module_path = Path(__file__).with_name("prepare-egress-gate.py")
spec = importlib.util.spec_from_file_location("egress_gate", module_path)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EgressProjectOwnershipTests(unittest.TestCase):
	def test_container_netns_uses_host_procfs_and_revalidates_docker_state(self) -> None:
		container = {
			"Id": "a" * 64,
			"State": {"Running": True, "Pid": 4321, "StartedAt": "2026-10-29T12:00:00Z"},
		}
		with patch.object(module.os, "readlink", return_value="net:[4026533001]") as readlink:
			with patch.object(module, "run", return_value=json.dumps([container])) as run:
				self.assertEqual(module.container_netns(container), "net:[4026533001]")
		readlink.assert_called_once_with("/proc/4321/ns/net")
		run.assert_called_once_with("docker", "inspect", "a" * 64)

	def test_container_netns_fails_closed_on_state_change_or_invalid_identity(self) -> None:
		container = {
			"Id": "b" * 64,
			"State": {"Running": True, "Pid": 4321, "StartedAt": "2026-10-29T12:00:00Z"},
		}
		changed = {
			"Id": "b" * 64,
			"State": {"Running": True, "Pid": 9876, "StartedAt": "2026-10-29T12:00:01Z"},
		}
		with patch.object(module.os, "readlink", return_value="net:[4026533001]"):
			with patch.object(module, "run", return_value=json.dumps([changed])):
				with self.assertRaisesRegex(RuntimeError, "changed while preparing"):
					module.container_netns(container)
		stopped = {"Id": "b" * 64, "State": {"Running": False, "Pid": 0}}
		with patch.object(module.os, "readlink") as readlink:
			with self.assertRaisesRegex(RuntimeError, "Cannot identify"):
				module.container_netns(stopped)
		readlink.assert_not_called()
		missing_pid = {
			"Id": "b" * 64,
			"State": {"Running": True, "Pid": 0, "StartedAt": "2026-10-29T12:00:00Z"},
		}
		with self.assertRaisesRegex(RuntimeError, "Cannot identify"):
			module.container_netns(missing_pid)
		with patch.object(module.os, "readlink", return_value="not-a-netns"):
			with self.assertRaisesRegex(RuntimeError, "invalid container network namespace"):
				module.container_netns(container)
		with patch.object(module.os, "readlink", side_effect=OSError("procfs unavailable")):
			with self.assertRaisesRegex(OSError, "procfs unavailable"):
				module.container_netns(container)

	def test_late_container_identity_check_detects_restart(self) -> None:
		container = {
			"Id": "c" * 64,
			"State": {"Running": True, "Pid": 4321, "StartedAt": "2026-10-29T12:00:00Z"},
		}
		changed = {
			"Id": "c" * 64,
			"State": {"Running": True, "Pid": 4321, "StartedAt": "2026-10-29T12:00:01Z"},
		}
		with patch.object(module, "run", return_value=json.dumps([changed])):
			with self.assertRaisesRegex(RuntimeError, "changed while preparing"):
				module.assert_container_identity_current(container)
		with patch.object(module, "run", return_value="[]"):
			with self.assertRaisesRegex(RuntimeError, "expected URLX container identity"):
				module.assert_container_identity_current(container)

	def test_rollback_deletes_only_its_marked_table_and_invalidates_readiness(self) -> None:
		marker = "urlx-egress-gate-test-marker"
		with tempfile.TemporaryDirectory() as directory:
			policy_dir = Path(directory)
			ready = policy_dir / "ready.json"
			ready.write_text("stale readiness")
			with patch.object(module, "run", return_value=f'table bridge urlx_egress {{ comment "{marker}"; }}') as run:
				module.rollback_installed_rules(policy_dir, marker)
			self.assertFalse(ready.exists())
			run.assert_any_call("nft", "delete", "table", "bridge", module.NFT_TABLE)

	def test_install_rules_embeds_unique_comment_ownership_marker(self) -> None:
		marker_suffix = "a1" * 16
		with patch.object(module.secrets, "token_hex", return_value=marker_suffix):
			with patch.object(module, "run", side_effect=subprocess.CalledProcessError(1, ["nft"])):
				with patch.object(module.subprocess, "run") as nft_apply:
					rule_hash, marker = module.install_rules("table bridge urlx_egress {\n}\n")
		self.assertEqual(marker, f"urlx-egress-gate-{marker_suffix}")
		self.assertRegex(rule_hash, r"^[a-f0-9]{64}$")
		self.assertIn(f'comment "{marker}";', nft_apply.call_args.kwargs["input"])

		with tempfile.TemporaryDirectory() as directory:
			policy_dir = Path(directory)
			ready = policy_dir / "ready.json"
			ready.write_text("stale readiness")
			with patch.object(module, "run", return_value=f'table bridge urlx_egress {{ comment "foreign-{marker}"; }}') as run:
				module.rollback_installed_rules(policy_dir, marker)
			self.assertFalse(ready.exists())
			run.assert_called_once_with("nft", "list", "table", "bridge", module.NFT_TABLE)

		with tempfile.TemporaryDirectory() as directory:
			policy_dir = Path(directory)
			ready = policy_dir / "ready.json"
			ready.write_text("stale readiness")
			with patch.object(
				module,
				"run",
				side_effect=subprocess.CalledProcessError(1, ["nft"]),
			) as run:
				module.rollback_installed_rules(policy_dir, marker)
			self.assertFalse(ready.exists())
			run.assert_called_once_with("nft", "list", "table", "bridge", module.NFT_TABLE)

		with tempfile.TemporaryDirectory() as directory:
			policy_dir = Path(directory)
			ready = policy_dir / "ready.json"
			ready.write_text("stale readiness")
			with patch.object(
				module,
				"run",
				side_effect=[f'table bridge urlx_egress {{ comment "{marker}"; }}', subprocess.CalledProcessError(1, ["nft"])],
			) as run:
				with self.assertRaises(subprocess.CalledProcessError):
					module.rollback_installed_rules(policy_dir, marker)
			self.assertFalse(ready.exists())
			run.assert_any_call("nft", "delete", "table", "bridge", module.NFT_TABLE)

	def test_empty_startup_inventory_allows_bootstrap_and_post_start_core_check(self) -> None:
		active_before_start = module.running_service_names("", require_core=False)
		self.assertEqual(module.egress_clients_to_stop(active_before_start), [])

		active_after_start = module.running_service_names(
			"web\napi\nconversion\negress-proxy\npostgres\nvalkey\n"
		)
		self.assertTrue(module.REQUIRED_RUNNING_SERVICES.issubset(active_after_start))

	def test_foreign_project_or_unowned_firewall_fails_before_startup(self) -> None:
		with self.assertRaisesRegex(RuntimeError, "Only one URLX Compose project"):
			module.assert_gate_preflight("urlx-test", {"urlx-other"}, None, False)
		with self.assertRaisesRegex(RuntimeError, "no owner manifest"):
			module.assert_gate_preflight("urlx-test", set(), None, True)

	def test_missing_policy_directory_is_allowed_only_without_an_unowned_table(self) -> None:
		with tempfile.TemporaryDirectory() as directory:
			policy_dir = Path(directory) / "not-created-yet"
			with patch.object(
				module,
				"run",
				side_effect=subprocess.CalledProcessError(1, ["nft"]),
			):
				manifest, table_exists = module.gate_owner_state(policy_dir)
			self.assertFalse(policy_dir.exists())
			module.assert_gate_preflight("urlx-test", set(), manifest, table_exists)
			with self.assertRaisesRegex(RuntimeError, "no owner manifest"):
				module.assert_gate_preflight("urlx-test", set(), manifest, True)

	def test_running_service_discovery_allows_only_known_optional_workloads(self) -> None:
		active = module.running_service_names(
			"web\napi\nconversion\negress-proxy\npostgres\nvalkey\n"
		)
		self.assertNotIn("conversion-renderer", active)
		with self.assertRaisesRegex(RuntimeError, "Unexpected Compose services"):
			module.running_service_names(
				"web\napi\nconversion\negress-proxy\npostgres\nvalkey\nother"
			)
		with self.assertRaisesRegex(RuntimeError, "Required Compose services"):
			module.running_service_names("web\napi\negress-proxy\npostgres\nvalkey")

	def test_browserless_conversion_requires_explicit_disabled_mode(self) -> None:
		service = {
			"container": {
				"Config": {"Env": ["CONVERSION_BROWSER_DISABLED=true"]}
			}
		}
		self.assertTrue(module.conversion_browser_disabled(service))
		module.assert_renderer_configuration({"conversion": service})
		enabled_service = {
			"container": {
				"Config": {"Env": ["CONVERSION_BROWSER_DISABLED=false"]}
			}
		}
		self.assertFalse(module.conversion_browser_disabled(enabled_service))
		with self.assertRaisesRegex(RuntimeError, "must be running"):
			module.assert_renderer_configuration({"conversion": enabled_service})
		with self.assertRaisesRegex(RuntimeError, "cannot be combined"):
			module.assert_renderer_configuration(
				{
					"conversion": {
						"container": {
							"Config": {"Env": ["CONVERSION_BROWSER_DISABLED=true"]}
						}
					},
					"conversion-renderer": {},
				}
			)

	def test_service_inspection_requires_urlx_service_and_project_labels(self) -> None:
		container = {
			"Config": {
				"Labels": {
					"com.urlx.stack": "urlx",
					"com.docker.compose.project": "urlx",
					"com.docker.compose.service": "api",
				}
			}
		}
		module.assert_service_identity("api", container)
		container["Config"]["Labels"]["com.docker.compose.project"] = "other"
		with self.assertRaisesRegex(RuntimeError, "expected URLX project labels"):
			module.assert_service_identity("api", container)

	def test_urlx_label_detects_renamed_compose_projects(self) -> None:
		containers = [
			{
				"Config": {
					"Labels": {
						"com.docker.compose.project": "custom-test-name",
						"com.urlx.stack": "urlx",
					}
				}
			},
			{
				"Config": {
					"Labels": {"com.docker.compose.project": "other-app"}
				}
			},
			{
				"Config": {
					"Labels": {"com.docker.compose.project": "urlx-e2e-preview"}
				}
			},
		]

		self.assertEqual(
			module.urlx_projects_from_containers(containers),
			{"custom-test-name", "urlx-e2e-preview"},
		)

	def test_exclusive_project_guard_allows_same_project_only(self) -> None:
		module.assert_no_other_urlx_project("urlx", {"urlx"})
		with self.assertRaisesRegex(RuntimeError, "Only one URLX Compose project"):
			module.assert_no_other_urlx_project("urlx-e2e-ci", {"urlx", "urlx-e2e-ci"})

	def test_existing_table_requires_matching_owner_manifest(self) -> None:
		module.assert_gate_owner("urlx-e2e-ci", {"composeProject": "urlx-e2e-ci"}, True)
		module.assert_gate_owner("urlx-e2e-ci", None, False)
		with self.assertRaisesRegex(RuntimeError, "no owner manifest"):
			module.assert_gate_owner("urlx-e2e-ci", None, True)
		with self.assertRaisesRegex(RuntimeError, "belongs to another Compose project"):
			module.assert_gate_owner("urlx-e2e-ci", {"composeProject": "urlx"}, True)


if __name__ == "__main__":
	unittest.main()
