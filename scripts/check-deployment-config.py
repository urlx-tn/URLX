#!/usr/bin/env python3
"""Validate bounded Valkey memory from Compose's already parsed JSON config."""

from __future__ import annotations

import json
import os
import sys
from decimal import Decimal, InvalidOperation
from typing import Any


def byte_count(value: Any, name: str) -> int:
	if isinstance(value, int) and not isinstance(value, bool):
		result = value
	elif isinstance(value, str) and value.isascii() and value.isdecimal():
		result = int(value)
	else:
		raise ValueError(f"{name} must be a positive integer byte count")
	if result < 1:
		raise ValueError(f"{name} must be a positive integer byte count")
	return result


def cpu_count(value: Any, name: str) -> Decimal:
	if isinstance(value, bool):
		raise ValueError(f"{name} must be a positive CPU quantity")
	try:
		result = Decimal(str(value))
	except (InvalidOperation, ValueError) as error:
		raise ValueError(f"{name} must be a positive CPU quantity") from error
	if not result.is_finite() or result <= 0:
		raise ValueError(f"{name} must be a positive CPU quantity")
	return result


def valkey_maxmemory(command: Any) -> int:
	if not isinstance(command, list) or not all(isinstance(arg, str) for arg in command):
		raise ValueError("Valkey command must be a resolved argument list")
	if not command or command[0] != "valkey-server":
		raise ValueError("Valkey command must invoke valkey-server directly")

	values: list[str] = []
	for index, argument in enumerate(command):
		if argument == "--maxmemory":
			if index + 1 >= len(command) or command[index + 1].startswith("--"):
				raise ValueError("Valkey --maxmemory requires a byte-count value")
			values.append(command[index + 1])
		elif argument.startswith("--maxmemory="):
			values.append(argument.partition("=")[2])
	if len(values) != 1:
		raise ValueError("Valkey command must define --maxmemory exactly once")
	return byte_count(values[0], "VALKEY_MAXMEMORY")


def require_loopback_port(service: dict[str, Any], name: str, target: int) -> int:
	ports = service.get("ports")
	if not isinstance(ports, list) or len(ports) != 1 or not isinstance(ports[0], dict):
		raise ValueError(f"{name} must publish exactly one loopback upstream port")
	port = ports[0]
	if port.get("host_ip") != "127.0.0.1" or port.get("target") != target:
		raise ValueError(f"{name} upstream must bind 127.0.0.1 and target container port {target}")
	if port.get("protocol", "tcp") != "tcp":
		raise ValueError(f"{name} upstream must use TCP")
	published = port.get("published")
	if isinstance(published, bool) or not str(published).isdecimal() or not 1 <= int(published) <= 65535:
		raise ValueError(f"{name} published upstream port must be between 1 and 65535")
	return int(published)


def require_postgres_tcp_healthcheck(service: dict[str, Any]) -> None:
	healthcheck = service.get("healthcheck", {})
	test = healthcheck.get("test") if isinstance(healthcheck, dict) else None
	if (
		not isinstance(test, list)
		or len(test) != 2
		or test[0] != "CMD-SHELL"
		or not isinstance(test[1], str)
		or "pg_isready" not in test[1]
		or "-h 127.0.0.1" not in test[1]
	):
		raise ValueError(
			"postgres healthcheck must use pg_isready over TCP on 127.0.0.1"
		)


def require_valid_tmpfs_entries(service: dict[str, Any], name: str) -> None:
	tmpfs = service.get("tmpfs")
	if tmpfs is None:
		return
	entries = [tmpfs] if isinstance(tmpfs, str) else tmpfs
	if not isinstance(entries, list):
		raise ValueError(f"{name}.tmpfs must be a string or a list of mount strings")
	for entry in entries:
		if not isinstance(entry, str) or not entry.startswith("/"):
			raise ValueError(
				f"{name}.tmpfs entries must each be one absolute path[:options] string"
			)
		path, separator, options = entry.partition(":")
		if not path.startswith("/"):
			raise ValueError(
				f"{name}.tmpfs options must stay with one absolute mount path"
			)
		if separator:
			for option in options.split(","):
				key, has_value, value = option.partition("=")
				if not key or (has_value and not value):
					raise ValueError(
						f"{name}.tmpfs options must stay with one absolute mount path"
					)


def require_valkey_runtime(service: dict[str, Any]) -> None:
	if service.get("user") != "999:1000":
		raise ValueError("valkey must run as the verified non-root UID:GID 999:1000")
	if "ALL" not in service.get("cap_drop", []) or service.get("cap_add"):
		raise ValueError("valkey must drop all capabilities without adding any")
	tmpfs = service.get("tmpfs", [])
	entries = [tmpfs] if isinstance(tmpfs, str) else tmpfs
	data_mounts = [
		entry
		for entry in entries
		if isinstance(entry, str) and entry.startswith("/data")
	]
	if len(data_mounts) != 1 or data_mounts[0].split(":", 1)[0] != "/data":
		raise ValueError("valkey requires one writable /data tmpfs")
	options = data_mounts[0].partition(":")[2].split(",")
	if "ro" in options or "mode=1777" not in options:
		raise ValueError("valkey /data tmpfs must be writable with mode 1777")


def validate_config(config: dict[str, Any]) -> dict[str, Any]:
	try:
		all_services = config["services"]
		known_services = {
			"web",
			"api",
			"conversion",
			"conversion-renderer",
			"postgres",
			"valkey",
			"migrate",
			"egress-proxy",
		}
		active_profiles = {
			profile.strip()
			for profile in os.environ.get("COMPOSE_PROFILES", "").split(",")
			if profile.strip()
		}
		services = {
			name: service
			for name, service in all_services.items()
			if not service.get("profiles")
			or active_profiles.intersection(service["profiles"])
		}
		for name, service in all_services.items():
			require_valid_tmpfs_entries(service, name)
		unknown_services = sorted(set(services) - known_services)
		if unknown_services:
			raise ValueError(
				f"Compose config has unexpected active services: {', '.join(unknown_services)}"
			)
		required_services = (
			"web",
			"api",
			"conversion",
			"postgres",
			"valkey",
			"migrate",
			"egress-proxy",
		)
		missing = [name for name in required_services if name not in services]
		if missing:
			raise ValueError(f"Compose resource limits are missing services: {', '.join(missing)}")
		require_postgres_tcp_healthcheck(services["postgres"])
		require_valkey_runtime(services["valkey"])
		published_ports = []
		for service_name, target_port in (("web", 8080), ("api", 8787), ("conversion", 8788)):
			published_ports.append(require_loopback_port(services[service_name], service_name, target_port))
		if len(set(published_ports)) != len(published_ports):
			raise ValueError("WEB_HOST_PORT, API_HOST_PORT, and CONVERSION_HOST_PORT must be distinct")
		for service_name, service in services.items():
			if service_name not in {"web", "api", "conversion"} and service.get("ports"):
				raise ValueError(f"{service_name} must not publish host ports")
		conversion_disabled = (
			services["conversion"].get("environment", {}).get(
				"CONVERSION_BROWSER_DISABLED", "false"
			)
			== "true"
		)
		renderer_enabled = "conversion-renderer" in services
		if conversion_disabled and (
			renderer_enabled or "browser" in active_profiles
		):
			raise ValueError(
				"CONVERSION_BROWSER_DISABLED=true cannot be combined with an active conversion-renderer profile"
			)
		if not conversion_disabled and not renderer_enabled:
			raise ValueError(
				"conversion-renderer is required unless CONVERSION_BROWSER_DISABLED=true"
			)
		if renderer_enabled:
			required_services += ("conversion-renderer",)
		limits = {
			name: (
				byte_count(services[name]["mem_limit"], f"{name}.mem_limit"),
				cpu_count(services[name]["cpus"], f"{name}.cpus"),
			)
			for name in required_services
		}
		api_labels = services["api"].get("labels", {})
		host_memory_budget = byte_count(
			api_labels["com.urlx.host-memory-budget-bytes"],
			"URLX_HOST_MEMORY_BUDGET_BYTES",
		)
		host_cpu_budget = cpu_count(
			api_labels["com.urlx.host-cpu-budget"], "URLX_HOST_CPU_BUDGET"
		)
		maxmemory = valkey_maxmemory(services["valkey"].get("command"))
		if renderer_enabled:
			try:
				renderer_concurrency = int(
					services["conversion-renderer"]["environment"]["RENDERER_CONCURRENCY"]
				)
			except (TypeError, ValueError) as error:
				raise ValueError("RENDERER_CONCURRENCY must be between 1 and 8") from error
		else:
			renderer_concurrency = 0
	except (KeyError, TypeError) as error:
		raise ValueError("Compose resource budgets or service limits are missing") from error
	if renderer_enabled and not 1 <= renderer_concurrency <= 8:
		raise ValueError("RENDERER_CONCURRENCY must be between 1 and 8")
	if maxmemory * 5 > limits["valkey"][0] * 4:
		raise ValueError(
			"VALKEY_MAXMEMORY must be no more than 80% of VALKEY_MEMORY_LIMIT"
		)
	if renderer_enabled:
		renderer_memory, renderer_cpus = limits["conversion-renderer"]
		if renderer_memory < renderer_concurrency * 512 * 1024 * 1024:
			raise ValueError(
				"CONVERSION_RENDERER_MEMORY_LIMIT must reserve at least 512 MiB per renderer context"
			)
		if renderer_cpus < Decimal(renderer_concurrency) / 2:
			raise ValueError(
				"CONVERSION_RENDERER_CPU_LIMIT must reserve at least 0.5 CPU per renderer context"
			)
	total_memory = sum(memory for memory, _ in limits.values())
	total_cpus = sum((cpus for _, cpus in limits.values()), Decimal(0))
	if total_memory > host_memory_budget:
		raise ValueError(
			"The sum of service memory caps exceeds URLX_HOST_MEMORY_BUDGET_BYTES"
		)
	if total_cpus > host_cpu_budget:
		raise ValueError("The sum of service CPU caps exceeds URLX_HOST_CPU_BUDGET")
	return {
		"total_memory": total_memory,
		"memory_budget": host_memory_budget,
		"total_cpus": total_cpus,
		"cpu_budget": host_cpu_budget,
		"valkey_maxmemory": maxmemory,
		"valkey_memory": limits["valkey"][0],
		"renderer_concurrency": renderer_concurrency,
	}


def main() -> int:
	try:
		config = json.load(sys.stdin)
		result = validate_config(config)
	except (json.JSONDecodeError, ValueError) as error:
		print(f"Deployment preflight failed: {error}", file=sys.stderr)
		return 1
	print(
		"Resource preflight passed "
		f"(memory={result['total_memory']}/{result['memory_budget']} bytes, "
		f"CPU={result['total_cpus']}/{result['cpu_budget']}, "
		f"renderer contexts={result['renderer_concurrency']})."
	)
	return 0


if __name__ == "__main__":
	sys.exit(main())
