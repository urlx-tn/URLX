from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


module_path = Path(__file__).with_name("check-deployment-config.py")
spec = importlib.util.spec_from_file_location("deployment_config", module_path)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def config(maxmemory: object = 80_000_000, memory_limit: object = 100_000_000) -> dict:
	services = {
		name: {"mem_limit": "100000000", "cpus": "0.1"}
		for name in (
			"web",
			"api",
			"conversion",
			"conversion-renderer",
			"postgres",
			"valkey",
			"migrate",
			"egress-proxy",
		)
	}
	services["conversion-renderer"]["mem_limit"] = "536870912"
	services["conversion-renderer"]["cpus"] = "0.5"
	services["conversion-renderer"]["environment"] = {"RENDERER_CONCURRENCY": "1"}
	for name, target in (("web", 8080), ("api", 8787), ("conversion", 8788)):
		services[name]["ports"] = [
			{"target": target, "published": str(target), "host_ip": "127.0.0.1", "protocol": "tcp"}
		]
	services["valkey"].update(
		{
			"user": "999:1000",
			"cap_drop": ["ALL"],
			"tmpfs": ["/data:size=16m,mode=1777"],
			# This is the resolved `docker compose config --format json` argv shape.
			"command": [
				"valkey-server",
				"--save",
				"",
				"--appendonly",
				"no",
				"--maxmemory",
				str(maxmemory),
				"--maxmemory-policy",
				"noeviction",
			],
			"mem_limit": str(memory_limit),
		}
	)
	services["api"]["labels"] = {
		"com.urlx.host-memory-budget-bytes": "2000000000",
		"com.urlx.host-cpu-budget": "4",
	}
	services["postgres"]["healthcheck"] = {
		"test": [
			"CMD-SHELL",
			'pg_isready -h 127.0.0.1 -U urlx_bootstrap -d "$${POSTGRES_DB}"',
		]
	}
	services["api"]["tmpfs"] = ["/tmp:size=64m,mode=1777"]
	services["web"]["networks"] = {"app": {}, "web-egress": {}, "host-ingress": {}}
	services["api"]["networks"] = {
		"app": {}, "data": {}, "limits": {}, "api-egress": {}, "host-ingress": {}
	}
	services["conversion"]["networks"] = {
		"app": {}, "limits": {}, "renderer-control": {}, "conversion-egress": {}, "host-ingress": {}
	}
	services["conversion-renderer"]["networks"] = {"renderer-control": {}, "renderer-egress": {}}
	services["postgres"]["networks"] = {"data": {}}
	services["valkey"]["networks"] = {"limits": {}}
	services["migrate"]["networks"] = {"data": {}}
	services["egress-proxy"]["networks"] = {
		"proxy-outbound": {},
		"api-egress": {},
		"web-egress": {},
		"conversion-egress": {},
		"renderer-egress": {},
	}
	return {
		"services": services,
		"networks": {
			name: {"internal": True, "enable_ipv6": False}
			for name in (
				"app", "data", "limits", "renderer-control", "api-egress",
				"web-egress", "conversion-egress", "renderer-egress",
			)
		} | {
			"host-ingress": {"driver": "bridge", "enable_ipv6": False},
			"proxy-outbound": {"driver": "bridge", "enable_ipv6": False},
		},
	}


class DeploymentConfigTests(unittest.TestCase):
	def test_accepts_twenty_percent_headroom(self) -> None:
		result = module.validate_config(config("80000000", "100000000"))
		self.assertEqual(result["valkey_maxmemory"], 80_000_000)

	def test_requires_valkey_verified_nonroot_identity_and_writable_tmpfs(self) -> None:
		for update, message in (
			({"user": "0:0"}, "999:1000"),
			({"cap_drop": []}, "drop all capabilities"),
			({"cap_add": ["CHOWN"]}, "without adding any"),
			({"tmpfs": ["/data:ro,mode=1777"]}, "must be writable"),
			({"tmpfs": ["/data:mode=0555"]}, "must be writable"),
		):
			bad = config()
			bad["services"]["valkey"].update(update)
			with self.subTest(update=update), self.assertRaisesRegex(ValueError, message):
				module.validate_config(bad)

	def test_rejects_postgres_socket_only_healthcheck(self) -> None:
		bad = config()
		bad["services"]["postgres"]["healthcheck"]["test"][1] = (
			'pg_isready -U urlx_bootstrap -d "$${POSTGRES_DB}"'
		)
		with self.assertRaisesRegex(ValueError, "over TCP on 127.0.0.1"):
			module.validate_config(bad)

	def test_rejects_split_tmpfs_mount_options(self) -> None:
		bad = config()
		bad["services"]["api"]["tmpfs"] = ["/tmp:size=64m", "mode=1777"]
		with self.assertRaisesRegex(ValueError, "api.tmpfs entries"):
			module.validate_config(bad)

	def test_rejects_split_tmpfs_options_on_inactive_renderer(self) -> None:
		bad = config()
		bad["services"]["conversion-renderer"]["profiles"] = ["browser"]
		bad["services"]["conversion-renderer"]["tmpfs"] = [
			"/tmp:size=256m",
			"mode=1777",
		]
		with patch.dict("os.environ", {"COMPOSE_PROFILES": ""}):
			with self.assertRaisesRegex(ValueError, "conversion-renderer.tmpfs entries"):
				module.validate_config(bad)

	def test_accepts_valid_tmpfs_bare_option(self) -> None:
		valid = config()
		valid["services"]["api"]["tmpfs"] = ["/tmp:size=64m,noexec"]
		module.validate_config(valid)

	def test_rejects_insufficient_headroom(self) -> None:
		with self.assertRaisesRegex(ValueError, "80%"):
			module.validate_config(config("80000001", "100000000"))

	def test_rejects_units_and_non_numeric_limits(self) -> None:
		for value in ("32mb", "1e6", True, 0):
			with self.subTest(value=value), self.assertRaises(ValueError):
				module.byte_count(value, "VALKEY_MAXMEMORY")

	def test_rejects_missing_duplicate_or_ambiguous_valkey_memory_flag(self) -> None:
		bad_commands = (
			["sh", "-c", "valkey-server", "--maxmemory", "80000000"],
			["valkey-server", "--appendonly", "no"],
			["valkey-server", "--maxmemory", "0"],
			["valkey-server", "--maxmemory", "-1"],
			["valkey-server", "--maxmemory", "80000000", "--maxmemory", "90000000"],
			["valkey-server", "--maxmemory", "--maxmemory-policy", "noeviction"],
			["valkey-server", "--maxmemory=80000000", "--maxmemory", "90000000"],
			"valkey-server --maxmemory 80000000",
		)
		for command in bad_commands:
			with self.subTest(command=command), self.assertRaises(ValueError):
				module.valkey_maxmemory(command)

	def test_rejects_missing_compose_service(self) -> None:
		with self.assertRaisesRegex(ValueError, "missing"):
			module.validate_config({"services": {}})

	def test_rejects_publicly_bound_service_upstream(self) -> None:
		bad = config()
		bad["services"]["api"]["ports"][0]["host_ip"] = "0.0.0.0"
		with self.assertRaisesRegex(ValueError, "127.0.0.1"):
			module.validate_config(bad)

	def test_host_ingress_is_project_bridge_attached_only_to_published_apps(self) -> None:
		module.validate_config(config())
		for mutate, message in (
			(
				lambda bad: bad["services"]["postgres"]["networks"].update({"host-ingress": {}}),
				"host-ingress may be attached only",
			),
			(
				lambda bad: bad["services"]["api"]["networks"].update({"untrusted": {}}),
				"unexpected external Docker network",
			),
			(
				lambda bad: bad["networks"]["host-ingress"].update({"internal": True}),
				"host-ingress must be",
			),
			(
				lambda bad: bad["networks"]["host-ingress"].update({"enable_ipv6": True}),
				"host-ingress must be",
			),
			(
				lambda bad: bad["services"]["egress-proxy"]["networks"].update({"host-ingress": {}}),
				"host-ingress may be attached only",
			),
		):
			bad = config()
			mutate(bad)
			with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
				module.validate_config(bad)

	def test_rejects_wrong_upstream_target_or_additional_published_ports(self) -> None:
		wrong_target = config()
		wrong_target["services"]["conversion"]["ports"][0]["target"] = 8787
		with self.assertRaisesRegex(ValueError, "target container port 8788"):
			module.validate_config(wrong_target)
		multiple = config()
		multiple["services"]["web"]["ports"].append(dict(multiple["services"]["web"]["ports"][0]))
		with self.assertRaisesRegex(ValueError, "exactly one"):
			module.validate_config(multiple)

	def test_rejects_duplicate_published_upstream_ports(self) -> None:
		bad = config()
		bad["services"]["api"]["ports"][0]["published"] = "8080"
		with self.assertRaisesRegex(ValueError, "must be distinct"):
			module.validate_config(bad)

	def test_rejects_published_internal_service_port(self) -> None:
		bad = config()
		bad["services"]["postgres"]["ports"] = [
			{"target": 5432, "published": "5432", "host_ip": "127.0.0.1", "protocol": "tcp"}
		]
		with self.assertRaisesRegex(ValueError, "postgres must not publish"):
			module.validate_config(bad)

	def test_rejects_unreviewed_active_compose_service(self) -> None:
		bad = config()
		bad["services"]["unreviewed-egress"] = {"mem_limit": "1", "cpus": "0.1"}
		with self.assertRaisesRegex(ValueError, "unexpected active services"):
			module.validate_config(bad)

	def test_rejects_total_limits_over_host_budget(self) -> None:
		bad = config()
		bad["services"]["api"]["labels"]["com.urlx.host-memory-budget-bytes"] = "1000000000"
		with self.assertRaisesRegex(ValueError, "sum of service memory caps"):
			module.validate_config(bad)

	def test_requires_renderer_budget_for_each_context(self) -> None:
		bad = config()
		bad["services"]["conversion-renderer"]["environment"]["RENDERER_CONCURRENCY"] = "2"
		with self.assertRaisesRegex(ValueError, "512 MiB per renderer context"):
			module.validate_config(bad)

	def test_ignores_renderer_budget_when_its_profile_is_inactive(self) -> None:
		vps_test = config()
		vps_test["services"]["conversion"]["environment"] = {
			"CONVERSION_BROWSER_DISABLED": "true"
		}
		vps_test["services"]["conversion-renderer"]["profiles"] = ["browser"]
		vps_test["services"]["conversion-renderer"].update(
			{"mem_limit": "1", "cpus": "0.01"}
		)
		with patch.dict("os.environ", {"COMPOSE_PROFILES": ""}):
			result = module.validate_config(vps_test)
		self.assertEqual(result["renderer_concurrency"], 0)
		self.assertLess(result["total_memory"], 2_000_000_000)

	def test_rejects_disabled_mode_when_browser_profile_is_active(self) -> None:
		contradictory = config()
		contradictory["services"]["conversion"]["environment"] = {
			"CONVERSION_BROWSER_DISABLED": "true"
		}
		contradictory["services"]["conversion-renderer"]["profiles"] = ["browser"]
		with patch.dict("os.environ", {"COMPOSE_PROFILES": "browser"}):
			with self.assertRaisesRegex(ValueError, "cannot be combined"):
				module.validate_config(contradictory)

	def test_requires_renderer_for_normal_conversion_mode(self) -> None:
		normal = config()
		normal["services"]["conversion"]["environment"] = {
			"CONVERSION_BROWSER_DISABLED": "false"
		}
		normal["services"]["conversion-renderer"]["profiles"] = ["browser"]
		with patch.dict("os.environ", {"COMPOSE_PROFILES": ""}):
			with self.assertRaisesRegex(ValueError, "renderer is required"):
				module.validate_config(normal)


if __name__ == "__main__":
	unittest.main()
