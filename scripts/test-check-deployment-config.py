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
			"caddy",
		)
	}
	services["conversion-renderer"]["mem_limit"] = "536870912"
	services["conversion-renderer"]["cpus"] = "0.5"
	services["conversion-renderer"]["environment"] = {"RENDERER_CONCURRENCY": "1"}
	services["valkey"].update(
		{
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
	return {
		"services": services
	}


class DeploymentConfigTests(unittest.TestCase):
	def test_accepts_twenty_percent_headroom(self) -> None:
		result = module.validate_config(config("80000000", "100000000"))
		self.assertEqual(result["valkey_maxmemory"], 80_000_000)

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
