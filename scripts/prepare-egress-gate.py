#!/usr/bin/env python3
"""Install URLX-scoped bridge rules and write the runtime readiness manifest."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
	import fcntl
except ImportError:  # pragma: no cover - the gate itself runs only on Linux.
	fcntl = None

PROJECT_NAME_PATTERN = re.compile(r"^urlx(-[a-z0-9][a-z0-9_-]{0,42})?$")
COMPOSE_PROJECT = "urlx"
NFT_TABLE = "urlx_egress"
LOCK_PATH = Path("/run/lock/urlx-egress-gate.lock")
KNOWN_SERVICES = {
	"web",
	"api",
	"conversion",
	"conversion-renderer",
	"egress-proxy",
	"postgres",
	"valkey",
	"migrate",
	"caddy",
}
REQUIRED_RUNNING_SERVICES = {"web", "api", "conversion", "egress-proxy", "postgres", "valkey"}


def run(*args: str) -> str:
	return subprocess.check_output(args, text=True).strip()


def compose(*args: str) -> str:
	return run("docker", "compose", "--project-name", COMPOSE_PROJECT, *args)


def acquire_gate_lock() -> int:
	if fcntl is None:
		raise RuntimeError("The URLX egress gate host lock requires Linux")
	passed_fd = os.environ.get("URLX_EGRESS_LOCK_FD")
	if passed_fd is not None:
		try:
			fd = int(passed_fd)
			os.fstat(fd)
		except (ValueError, OSError) as error:
			raise RuntimeError("Invalid inherited URLX egress lock descriptor") from error
		lock_target = os.path.realpath(f"/proc/self/fd/{fd}")
		if lock_target != os.path.realpath(LOCK_PATH):
			raise RuntimeError("Inherited descriptor is not the URLX egress host lock")
		fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
		return fd
	try:
		LOCK_PATH.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
		fd = os.open(LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o600)
		fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
		return fd
	except (OSError, BlockingIOError) as error:
		if "fd" in locals():
			os.close(fd)
		raise RuntimeError("Another URLX egress gate operation holds the host lock") from error


def is_urlx_project(project: str, labels: dict[str, str]) -> bool:
	return labels.get("com.urlx.stack") == "urlx" or bool(
		PROJECT_NAME_PATTERN.fullmatch(project)
	)


def assert_no_other_urlx_project(project: str, projects: set[str]) -> None:
	other_projects = sorted(
		name
		for name in projects
		if name != project
	)
	if other_projects:
		raise RuntimeError(
			"Only one URLX Compose project may be active on this host; "
			f"stop {', '.join(other_projects)} before using {project}"
		)


def assert_gate_preflight(
	project: str,
	projects: set[str],
	manifest: dict | None,
	table_exists: bool,
) -> None:
	assert_no_other_urlx_project(project, projects)
	assert_gate_owner(project, manifest, table_exists)


def running_compose_projects() -> set[str]:
	container_ids = run(
		"docker", "ps", "--quiet", "--filter", "label=com.docker.compose.project"
	).splitlines()
	if not container_ids:
		return set()
	containers = json.loads(run("docker", "inspect", *container_ids))
	return urlx_projects_from_containers(containers)


def urlx_projects_from_containers(containers: list[dict]) -> set[str]:
	projects = set()
	for container in containers:
		labels = container.get("Config", {}).get("Labels", {})
		project = labels.get("com.docker.compose.project", "")
		if project and is_urlx_project(project, labels):
			projects.add(project)
	return projects


def assert_gate_owner(project: str, manifest: dict | None, table_exists: bool) -> None:
	if table_exists and manifest is None:
		raise RuntimeError("Existing URLX nftables table has no owner manifest; refusing mutation")
	if manifest is not None and manifest.get("composeProject") != project:
		raise RuntimeError("URLX egress manifest belongs to another Compose project")


def gate_owner_state(policy_dir: Path) -> tuple[dict | None, bool]:
	manifest_path = policy_dir / "ready.json"
	manifest = None
	if policy_dir.exists() and not policy_dir.is_dir():
		raise RuntimeError("URLX egress policy path is not a directory")
	if manifest_path.exists():
		try:
			manifest = json.loads(manifest_path.read_text())
		except (OSError, json.JSONDecodeError) as error:
			raise RuntimeError("URLX egress owner manifest is malformed") from error
	try:
		run("nft", "list", "table", "bridge", NFT_TABLE)
		table_exists = True
	except subprocess.CalledProcessError:
		table_exists = False
	return manifest, table_exists


def read_gate_owner(policy_dir: Path, project: str) -> None:
	manifest, table_exists = gate_owner_state(policy_dir)
	assert_gate_owner(project, manifest, table_exists)


def check_active_project(project: str) -> None:
	assert_no_other_urlx_project(project, running_compose_projects())


def inspect_service(service: str) -> dict:
	container_id = compose("ps", "-q", service)
	if not container_id:
		raise RuntimeError(f"Compose service is not running: {service}")
	return json.loads(run("docker", "inspect", container_id))[0]


def inspect_network(network_id: str) -> dict:
	return json.loads(run("docker", "network", "inspect", network_id))[0]


def assert_service_identity(service_name: str, container: dict) -> None:
	labels = container.get("Config", {}).get("Labels", {})
	if (
		labels.get("com.urlx.stack") != "urlx"
		or labels.get("com.docker.compose.project") != COMPOSE_PROJECT
		or labels.get("com.docker.compose.service") != service_name
	):
		raise RuntimeError(
			f"Compose service {service_name} is missing the expected URLX project labels"
		)


def running_service_names(output: str, require_core: bool = True) -> set[str]:
	services = {name.strip() for name in output.splitlines() if name.strip()}
	unknown = sorted(services - KNOWN_SERVICES)
	if unknown:
		raise RuntimeError(f"Unexpected Compose services are active: {', '.join(unknown)}")
	if require_core:
		missing = sorted(REQUIRED_RUNNING_SERVICES - services)
		if missing:
			raise RuntimeError(f"Required Compose services are not running: {', '.join(missing)}")
	return services


def egress_clients_to_stop(services: set[str]) -> list[str]:
	return sorted(
		services
		& {"web", "api", "conversion", "conversion-renderer", "egress-proxy"}
	)


def conversion_browser_disabled(service: dict) -> bool:
	values = service["container"].get("Config", {}).get("Env", [])
	return "CONVERSION_BROWSER_DISABLED=true" in values


def assert_renderer_configuration(services: dict[str, dict]) -> None:
	renderer_enabled = "conversion-renderer" in services
	if conversion_browser_disabled(services["conversion"]) and renderer_enabled:
		raise RuntimeError(
			"CONVERSION_BROWSER_DISABLED=true cannot be combined with an active conversion-renderer service"
		)
	if not conversion_browser_disabled(services["conversion"]) and not renderer_enabled:
		raise RuntimeError(
			"The conversion-renderer service must be running unless browser conversion is explicitly disabled"
		)


def service_info(service: str) -> dict:
	container = inspect_service(service)
	assert_service_identity(service, container)
	container_id = container["Id"]
	networks = {}
	for network_name, endpoint in container["NetworkSettings"]["Networks"].items():
		network_id = endpoint["NetworkID"]
		ip = endpoint.get("IPAddress", "")
		mac = endpoint.get("MacAddress", "").lower()
		if not ip or not mac:
			continue
		if ipaddress.ip_address(ip).version != 4:
			raise RuntimeError(f"IPv6 container address is not enabled for {service}")
		network = inspect_network(network_id)
		if network.get("EnableIPv6"):
			raise RuntimeError(f"IPv6 must be disabled on URLX network {network_name}")
		networks[network_id] = {
			"networkId": network_id,
			"ip": ip,
			"mac": mac,
			"name": network_name,
			"internal": bool(network.get("Internal")),
			"bridge": network.get("Options", {}).get("com.docker.network.bridge.name")
			or f"br-{network_id[:12]}",
		}
	if not networks:
		raise RuntimeError(f"No IPv4 network addresses found for {service}")
	return {
		"container": container,
		"containerId": container_id,
		"hostname": container["Config"].get("Hostname", ""),
		"netns": run("docker", "exec", container_id, "readlink", "/proc/self/ns/net"),
		"networks": networks,
	}


def shared_networks(left: dict, right: dict) -> list[str]:
	return sorted(set(left["networks"]) & set(right["networks"]))


def make_rules(services: dict[str, dict], host_addresses: list[str]) -> str:
	container_ips = sorted(
		{
			endpoint["ip"]
			for service in services.values()
			for endpoint in service["networks"].values()
		}
	)
	if not container_ips:
		raise RuntimeError("No URLX container IP addresses found")

	blocked = [
		"0.0.0.0/8",
		"10.0.0.0/8",
		"100.64.0.0/10",
		"127.0.0.0/8",
		"169.254.0.0/16",
		"172.16.0.0/12",
		"192.0.0.0/24",
		"192.0.2.0/24",
		"192.168.0.0/16",
		"198.18.0.0/15",
		"198.51.100.0/24",
		"203.0.113.0/24",
		"224.0.0.0/4",
		"240.0.0.0/4",
		"255.255.255.255/32",
	]
	blocked.extend(
		str(ipaddress.ip_address(address))
		for address in host_addresses
		if ipaddress.ip_address(address).version == 4
	)
	blocked = sorted(set(blocked), key=lambda item: (ipaddress.ip_network(item, strict=False).network_address, ipaddress.ip_network(item, strict=False).prefixlen))

	lines = [
		"table bridge urlx_egress {",
		f"\tset urlx_containers {{ type ipv4_addr; elements = {{ {', '.join(container_ips)} }} }}",
		f"\tset urlx_blocked4 {{ type ipv4_addr; flags interval; elements = {{ {', '.join(blocked)} }} }}",
		"\tchain input {",
		"\t\ttype filter hook input priority -300; policy accept;",
		"\t\tip saddr @urlx_containers drop",
		"\t}",
		"\tchain forward {",
		"\t\ttype filter hook forward priority -300; policy accept;",
		"\t\tct state established,related accept",
	]

	allowed_edges = [
		("web", "api", 8787),
		("api", "postgres", 5432),
		("api", "valkey", 6379),
		("conversion", "valkey", 6379),
		("conversion", "conversion-renderer", 3100),
		("api", "egress-proxy", 3128),
		("web", "egress-proxy", 3128),
		("conversion", "egress-proxy", 3128),
		("conversion-renderer", "egress-proxy", 3128),
	]
	if "caddy" in services:
		allowed_edges.extend(
			[("caddy", "web", 8080), ("caddy", "api", 8787), ("caddy", "conversion", 8788)]
		)

	for source_name, target_name, port in allowed_edges:
		source = services.get(source_name)
		target = services.get(target_name)
		if not source or not target:
			continue
		for network_id in shared_networks(source, target):
			source_endpoint = source["networks"][network_id]
			target_endpoint = target["networks"][network_id]
			if not source_endpoint["internal"] or not target_endpoint["internal"]:
				if target_name != "egress-proxy":
					raise RuntimeError(f"Unexpected non-internal service path: {source_name} -> {target_name}")
			lines.append(
				f"\t\tip saddr {source_endpoint['ip']} ether saddr {source_endpoint['mac']} "
				f"ip daddr {target_endpoint['ip']} ether daddr {target_endpoint['mac']} "
				f"tcp dport {port} ct state new accept"
			)

	proxy = services["egress-proxy"]
	proxy_outbound = [
		endpoint for endpoint in proxy["networks"].values() if endpoint["name"].endswith("_proxy-outbound")
	]
	if len(proxy_outbound) != 1 or proxy_outbound[0]["internal"]:
		raise RuntimeError("Egress proxy must have exactly one public proxy-outbound network")
	proxy_endpoint = proxy_outbound[0]
	lines.append(
		f"\t\tip saddr {proxy_endpoint['ip']} ether saddr {proxy_endpoint['mac']} "
		"ip daddr != @urlx_blocked4 tcp dport { 80, 443 } ct state new accept"
	)
	lines.extend(
		[
		"\t\tip saddr @urlx_containers drop",
		"\t}",
		"}",
	]
	)
	return "\n".join(lines) + "\n"


def install_rules(rules: str) -> str:
	try:
		run("nft", "list", "table", "bridge", "urlx_egress")
		rules = "delete table bridge urlx_egress\n" + rules
	except subprocess.CalledProcessError:
		pass
	subprocess.run(["nft", "-f", "-"], input=rules, text=True, check=True)
	return hashlib.sha256(rules.encode("utf-8")).hexdigest()


def main() -> None:
	parser = argparse.ArgumentParser()
	parser.add_argument("--policy-dir", type=Path)
	parser.add_argument("--project", required=True)
	parser.add_argument("--check-active-only", action="store_true")
	parser.add_argument("--check-owner-only", action="store_true")
	parser.add_argument("--preflight-only", action="store_true")
	parser.add_argument("--list-egress-clients", action="store_true")
	args = parser.parse_args()
	if not PROJECT_NAME_PATTERN.fullmatch(args.project):
		raise RuntimeError("Compose project must be urlx or a validated urlx-prefixed name")
	acquire_gate_lock()
	global COMPOSE_PROJECT
	COMPOSE_PROJECT = args.project
	if args.preflight_only:
		if not args.policy_dir:
			parser.error("--policy-dir is required with --preflight-only")
		policy_dir = args.policy_dir.resolve(strict=False)
		manifest, table_exists = gate_owner_state(policy_dir)
		assert_gate_preflight(
			args.project, running_compose_projects(), manifest, table_exists
		)
		return
	check_active_project(args.project)
	if args.check_active_only:
		return
	if args.list_egress_clients:
		services = running_service_names(
			compose("ps", "--services", "--status", "running"),
			require_core=False,
		)
		for service in egress_clients_to_stop(services):
			print(service)
		return
	if not args.policy_dir:
		parser.error("--policy-dir is required unless checking project ownership")
	policy_dir = args.policy_dir.resolve(strict=True)
	read_gate_owner(policy_dir, args.project)
	if args.check_owner_only:
		return
	if not (policy_dir / "host-denylist.txt").is_file():
		raise RuntimeError("Host denylist must exist before starting the stack")
	host_addresses = sorted(
		{
			str(ipaddress.ip_address(line.strip()))
			for line in (policy_dir / "host-denylist.txt").read_text().splitlines()
			if line.strip()
		}
	)
	if not host_addresses:
		raise RuntimeError("Host denylist is empty")

	service_names = running_service_names(compose("ps", "--services", "--status", "running"))
	services = {name: service_info(name) for name in service_names}
	assert_renderer_configuration(services)
	check_active_project(args.project)
	read_gate_owner(policy_dir, args.project)

	for name, service in services.items():
		if name == "egress-proxy":
			continue
		if any(not network["internal"] for network in service["networks"].values()):
			raise RuntimeError(f"Service {name} has a non-internal external network")
	for endpoint in services["egress-proxy"]["networks"].values():
		if endpoint["name"].endswith("_proxy-outbound"):
			continue
		if not endpoint["internal"]:
			raise RuntimeError("Egress proxy client networks must be internal")

	rules = make_rules(services, host_addresses)
	rule_hash = install_rules(rules)

	manifest = {
		"policyVersion": 1,
		"composeProject": args.project,
		"verifiedAt": datetime.now(timezone.utc).isoformat(),
		"ruleSetHash": rule_hash,
		"hostAddresses": host_addresses,
		"proxy": {
			"containerId": services["egress-proxy"]["containerId"],
			"netns": services["egress-proxy"]["netns"],
			"networks": [
				{
					"networkId": endpoint["networkId"],
					"ip": endpoint["ip"],
					"mac": endpoint["mac"],
				}
				for endpoint in services["egress-proxy"]["networks"].values()
			],
		},
		"services": {
			name: {
				"containerId": service["containerId"],
				"hostname": service["hostname"],
				"netns": service["netns"],
				"networks": [
					{
						"networkId": endpoint["networkId"],
						"ip": endpoint["ip"],
						"mac": endpoint["mac"],
					}
					for endpoint in service["networks"].values()
				],
			}
			for name, service in services.items()
			if name in {"api", "web", "conversion", "conversion-renderer"}
		},
	}
	temporary = policy_dir / "ready.json.tmp"
	temporary.write_text(json.dumps(manifest, indent=2) + "\n")
	os.chmod(temporary, 0o644)
	os.replace(temporary, policy_dir / "ready.json")


if __name__ == "__main__":
	try:
		main()
	except (OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError) as error:
		print(f"Egress gate setup failed closed: {error}", file=sys.stderr)
		sys.exit(1)
