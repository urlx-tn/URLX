from __future__ import annotations

import importlib.util
import ipaddress
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


def owner_manifest(project: str) -> dict:
	network = {
		"networkId": "a" * 64,
		"ip": "172.29.0.3",
		"mac": "02:42:ac:1d:00:03",
	}
	return {
		"policyVersion": 1,
		"composeProject": project,
		"verifiedAt": "2026-10-29T17:00:00+00:00",
		"ruleSetHash": "b" * 64,
		"hostAddresses": ["203.0.113.10"],
		"proxy": {
			"containerId": "c" * 64,
			"netns": "net:[4026533001]",
			"networks": [network],
		},
		"services": {
			name: {
				"containerId": f"{letter}" * 64,
				"hostname": letter * 12,
				"netns": "net:[4026533002]",
				"networks": [network],
			}
			for name, letter in (("api", "d"), ("web", "e"), ("conversion", "f"))
		},
	}


class EgressAddressSetTests(unittest.TestCase):
	def test_blocked_ipv4_union_collapses_contained_hosts_and_keeps_public_hosts(self) -> None:
		blocked = [
			ipaddress.ip_network(value)
			for value in module.blocked_ipv4_networks(
				["127.0.0.1", "172.31.0.1", "192.168.20.1", "8.8.8.8", "2001:db8::1"]
			)
		]
		self.assertFalse(
			any(left.overlaps(right) for index, left in enumerate(blocked) for right in blocked[index + 1 :])
		)
		for address in ("127.0.0.1", "172.31.0.1", "192.168.20.1", "8.8.8.8"):
			parsed = ipaddress.ip_address(address)
			self.assertTrue(any(parsed in network for network in blocked), address)
		self.assertIn("8.8.8.8/32", [str(network) for network in blocked])
		self.assertNotIn("127.0.0.1/32", [str(network) for network in blocked])

	def test_canonicalization_merges_adjacent_and_nested_ipv4_and_ipv6_networks(self) -> None:
		self.assertEqual(
			module.canonicalize_ip_networks(
				["198.0.0.0/16", "198.1.0.0/16", "198.0.4.1/32"]
			),
			["198.0.0.0/15"],
		)
		self.assertEqual(
			module.canonicalize_ip_networks(
				["2001:db8::/33", "2001:db8:8000::/33", "2001:db8:1::/48"]
			),
			["2001:db8::/32"],
		)


class EgressProjectOwnershipTests(unittest.TestCase):
	def test_runtime_invalidation_deletes_only_owned_table_after_readiness_is_hidden(self) -> None:
		with tempfile.TemporaryDirectory() as directory:
			policy_dir = Path(directory)
			ready_path = policy_dir / "ready.json"
			ready_path.write_text(json.dumps(owner_manifest("urlx-test")))
			(policy_dir / "ready.json.tmp").write_text("stale temp")
			denylist = policy_dir / "host-denylist.txt"
			denylist.write_text("203.0.113.10\n")
			marker = "urlx-egress-gate-" + "a" * 32
			nft_listing = f'table bridge urlx_egress {{\n\tcomment "{marker}"\n}}'
			calls: list[tuple[str, ...]] = []

			def run(*args: str) -> str:
				calls.append(args)
				if args[:3] == ("nft", "list", "table"):
					return nft_listing
				if args[:3] == ("nft", "delete", "table"):
					self.assertFalse(ready_path.exists())
					self.assertTrue((policy_dir / module.OWNER_SIDECAR).is_file())
					self.assertTrue(denylist.is_file())
					return ""
				self.fail(f"unexpected command: {args}")
				return ""

			with patch.object(module, "run", side_effect=run):
				module.invalidate_runtime_policy(policy_dir, "urlx-test", set())
			self.assertFalse(ready_path.exists())
			self.assertFalse((policy_dir / module.OWNER_SIDECAR).exists())
			self.assertFalse((policy_dir / "ready.json.tmp").exists())
			self.assertTrue(denylist.is_file())
			self.assertEqual(calls[-1], ("nft", "delete", "table", "bridge", module.NFT_TABLE))

	def test_runtime_invalidation_keeps_owner_sidecar_after_delete_failure_and_retry_clears_it(self) -> None:
		with tempfile.TemporaryDirectory() as directory:
			policy_dir = Path(directory)
			manifest = owner_manifest("urlx-test")
			ready_path = policy_dir / "ready.json"
			ready_path.write_text(json.dumps(manifest))
			(policy_dir / "ready.json.tmp").write_text("stale temp")
			marker = "urlx-egress-gate-" + "b" * 32
			delete_error = subprocess.CalledProcessError(1, ["nft", "delete"])
			with patch.object(
				module,
				"run",
				side_effect=[
					f'table bridge urlx_egress {{\n\tcomment "{marker}"\n}}',
					f'table bridge urlx_egress {{\n\tcomment "{marker}"\n}}',
					delete_error,
				],
			):
				with self.assertRaises(subprocess.CalledProcessError):
					module.invalidate_runtime_policy(policy_dir, "urlx-test", set())
			self.assertFalse(ready_path.exists())
			self.assertFalse((policy_dir / "ready.json.tmp").exists())
			self.assertEqual(
				json.loads((policy_dir / module.OWNER_SIDECAR).read_text()), manifest
			)

			with patch.object(
				module,
				"run",
				side_effect=[
					f'table bridge urlx_egress {{\n\tcomment "{marker}";\n}}',
					f'table bridge urlx_egress {{\n\tcomment "{marker}";\n}}',
					"",
				],
			) as run:
				module.invalidate_runtime_policy(policy_dir, "urlx-test", set())
			self.assertFalse((policy_dir / module.OWNER_SIDECAR).exists())
			run.assert_any_call("nft", "delete", "table", "bridge", module.NFT_TABLE)

	def test_runtime_invalidation_rejects_live_clients_foreign_owners_and_bad_manifests(self) -> None:
		with tempfile.TemporaryDirectory() as directory:
			policy_dir = Path(directory)
			ready_path = policy_dir / "ready.json"
			ready_path.write_text(json.dumps(owner_manifest("urlx-test")))
			with patch.object(module, "run") as run:
				with self.assertRaisesRegex(RuntimeError, "must be stopped"):
					module.invalidate_runtime_policy(policy_dir, "urlx-test", {"api"})
			run.assert_not_called()
			self.assertTrue(ready_path.exists())

			ready_path.write_text(json.dumps(owner_manifest("urlx-other")))
			with patch.object(module, "run", return_value="table bridge urlx_egress {}") as run:
				with self.assertRaisesRegex(RuntimeError, "belongs to another"):
					module.invalidate_runtime_policy(policy_dir, "urlx-test", set())
			run.assert_called_once_with("nft", "list", "table", "bridge", module.NFT_TABLE)
			self.assertTrue(ready_path.exists())

			ready_path.write_text(json.dumps({"composeProject": "urlx-test"}))
			with patch.object(module, "run", return_value="table bridge urlx_egress {}") as run:
				with self.assertRaisesRegex(RuntimeError, "manifest is invalid"):
					module.invalidate_runtime_policy(policy_dir, "urlx-test", set())
			run.assert_called_once_with("nft", "list", "table", "bridge", module.NFT_TABLE)
			self.assertTrue(ready_path.exists())

			wrong_marker = "urlx-egress-gate-" + "a" * 32 + "x"
			ready_path.write_text(json.dumps(owner_manifest("urlx-test")))
			listing = f'table bridge urlx_egress {{\n\tcomment "{wrong_marker}"\n}}'
			with patch.object(module, "run", return_value=listing) as run:
				with self.assertRaisesRegex(RuntimeError, "verified install marker"):
					module.invalidate_runtime_policy(policy_dir, "urlx-test", set())
			self.assertEqual(run.call_count, 2)
			self.assertTrue(ready_path.exists())

	def test_runtime_invalidation_refuses_unowned_table_but_allows_cold_start(self) -> None:
		with tempfile.TemporaryDirectory() as directory:
			policy_dir = Path(directory)
			with patch.object(module, "run", return_value="table bridge urlx_egress {}") as run:
				with self.assertRaisesRegex(RuntimeError, "no owner manifest"):
					module.invalidate_runtime_policy(policy_dir, "urlx-test", set())
			run.assert_called_once_with("nft", "list", "table", "bridge", module.NFT_TABLE)

			ready_temp = policy_dir / "ready.json.tmp"
			ready_temp.write_text("incomplete")
			with patch.object(
				module,
				"run",
				side_effect=subprocess.CalledProcessError(1, ["nft", "list"]),
			):
				module.invalidate_runtime_policy(policy_dir, "urlx-test", set())
			self.assertFalse(ready_temp.exists())

	def test_owner_state_uses_safe_sidecar_fallback_and_rejects_ambiguity_or_symlinks(self) -> None:
		with tempfile.TemporaryDirectory() as directory:
			policy_dir = Path(directory)
			owner_path = policy_dir / module.OWNER_SIDECAR
			manifest = owner_manifest("urlx-test")
			owner_path.write_text(json.dumps(manifest))
			with patch.object(
				module,
				"run",
				side_effect=subprocess.CalledProcessError(1, ["nft", "list"]),
			):
				self.assertEqual(module.gate_owner_state(policy_dir), (manifest, False))

			ready_path = policy_dir / "ready.json"
			ready_path.write_text(json.dumps({**manifest, "ruleSetHash": "c" * 64}))
			with patch.object(module, "run") as run:
				with self.assertRaisesRegex(RuntimeError, "ambiguous"):
					module.gate_owner_state(policy_dir)
			run.assert_not_called()
			ready_path.unlink()
			with patch.object(
				Path,
				"is_symlink",
				autospec=True,
				side_effect=lambda path: path.name == module.OWNER_SIDECAR,
			):
				with patch.object(module, "run") as run:
					with self.assertRaisesRegex(RuntimeError, "path is unsafe"):
						module.gate_owner_state(policy_dir)
			run.assert_not_called()

	def test_nft_marker_parser_accepts_normalized_comments_but_rejects_near_matches(self) -> None:
		marker = "urlx-egress-gate-3a4c993afae41dc0d833440bbbad0574"
		self.assertTrue(
			module.nft_table_has_install_marker(
				f'table bridge urlx_egress {{\n\tcomment "{marker}"\n}}', marker
			)
		)
		self.assertTrue(
			module.nft_table_has_install_marker(
				f'table bridge urlx_egress {{\n\tcomment "{marker}";\n}}', marker
			)
		)
		for listing in (
			f'\tcomment "x{marker}"',
			f'\tcomment "{marker}x"',
			f'\tcomment "{marker}" extra',
			f'\tcomment "urlx-egress-gate-{"a" * 31}"',
		):
			self.assertFalse(module.nft_table_has_install_marker(listing, marker), listing)
		self.assertFalse(module.nft_table_has_install_marker(f'\tcomment "{marker}" extra'))

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
		marker = "urlx-egress-gate-" + "d" * 32
		with tempfile.TemporaryDirectory() as directory:
			policy_dir = Path(directory)
			ready = policy_dir / "ready.json"
			ready.write_text("stale readiness")
			with patch.object(
				module,
				"run",
				return_value=f'table bridge urlx_egress {{\n\tcomment "{marker}"\n}}',
			) as run:
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
				side_effect=[
					f'table bridge urlx_egress {{\n\tcomment "{marker}";\n}}',
					subprocess.CalledProcessError(1, ["nft"]),
				],
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
		module.assert_gate_owner("urlx-e2e-ci", owner_manifest("urlx-e2e-ci"), True)
		module.assert_gate_owner("urlx-e2e-ci", None, False)
		with self.assertRaisesRegex(RuntimeError, "no owner manifest"):
			module.assert_gate_owner("urlx-e2e-ci", None, True)
		with self.assertRaisesRegex(RuntimeError, "belongs to another Compose project"):
			module.assert_gate_owner("urlx-e2e-ci", owner_manifest("urlx"), True)
		invalid_version = owner_manifest("urlx-e2e-ci")
		invalid_version["policyVersion"] = True
		with self.assertRaisesRegex(RuntimeError, "manifest is invalid"):
			module.assert_gate_owner("urlx-e2e-ci", invalid_version, True)
		unknown_service = owner_manifest("urlx-e2e-ci")
		unknown_service["services"]["other"] = unknown_service["services"]["api"]
		with self.assertRaisesRegex(RuntimeError, "manifest is invalid"):
			module.assert_gate_owner("urlx-e2e-ci", unknown_service, True)


if __name__ == "__main__":
	unittest.main()
