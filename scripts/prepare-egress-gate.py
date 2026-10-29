#!/usr/bin/env python3
"""Install URLX-scoped bridge rules and write the runtime readiness manifest."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import secrets
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
OWNER_SIDECAR = "ready.json.owner"
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
}
REQUIRED_RUNNING_SERVICES = {"web", "api", "conversion", "egress-proxy", "postgres", "valkey"}
HOST_INGRESS_PORTS = {"web": 8080, "api": 8787, "conversion": 8788}


def host_ingress_network_name() -> str:
	return f"{COMPOSE_PROJECT}_host-ingress"


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
	if manifest is not None and not gate_owner_manifest_is_valid(manifest, project):
		raise RuntimeError("URLX egress owner manifest is invalid; refusing mutation")


def gate_owner_manifest_is_valid(manifest: dict, project: str) -> bool:
	def valid_id(value: object) -> bool:
		return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value, re.I) is not None

	def valid_networks(value: object) -> bool:
		return isinstance(value, list) and bool(value) and all(
			isinstance(network, dict)
			and valid_id(network.get("networkId"))
			and isinstance(network.get("ip"), str)
			and _valid_ip(network["ip"])
			and isinstance(network.get("mac"), str)
			and re.fullmatch(r"(?:[a-f0-9]{2}:){5}[a-f0-9]{2}", network["mac"], re.I)
			for network in value
		)

	if (
		type(manifest.get("policyVersion")) is not int
		or manifest["policyVersion"] != 1
		or manifest.get("composeProject") != project
		or not isinstance(manifest.get("ruleSetHash"), str)
		or not re.fullmatch(r"[a-f0-9]{64}", manifest["ruleSetHash"], re.I)
		or not isinstance(manifest.get("hostAddresses"), list)
		or not manifest["hostAddresses"]
		or any(not _valid_ip(address) for address in manifest["hostAddresses"])
		or not isinstance(manifest.get("verifiedAt"), str)
		or not isinstance(manifest.get("proxy"), dict)
		or not valid_id(manifest["proxy"].get("containerId"))
		or not isinstance(manifest["proxy"].get("netns"), str)
		or not re.fullmatch(r"net:\[\d+\]", manifest["proxy"]["netns"])
		or not valid_networks(manifest["proxy"].get("networks"))
		or not isinstance(manifest.get("services"), dict)
	):
		return False
	try:
		verified_at = datetime.fromisoformat(manifest["verifiedAt"].replace("Z", "+00:00"))
	except ValueError:
		return False
	if verified_at.tzinfo is None:
		return False
	services = manifest["services"]
	if (
		not {"api", "web", "conversion"}.issubset(services)
		or not set(services).issubset({"api", "web", "conversion", "conversion-renderer"})
	):
		return False
	for service in services.values():
		if (
			not isinstance(service, dict)
			or not valid_id(service.get("containerId"))
			or not isinstance(service.get("hostname"), str)
			or not re.fullmatch(r"[a-f0-9]{12,64}", service["hostname"], re.I)
			or not service["containerId"].lower().startswith(service["hostname"].lower())
			or not isinstance(service.get("netns"), str)
			or not re.fullmatch(r"net:\[\d+\]", service["netns"])
			or not valid_networks(service.get("networks"))
		):
			return False
	return True


def _valid_ip(value: object) -> bool:
	if not isinstance(value, str):
		return False
	try:
		ipaddress.ip_address(value)
		return True
	except ValueError:
		return False


def gate_owner_state(policy_dir: Path) -> tuple[dict | None, bool]:
	manifest_path = policy_dir / "ready.json"
	owner_path = policy_dir / OWNER_SIDECAR
	manifest = None
	if policy_dir.exists() and not policy_dir.is_dir():
		raise RuntimeError("URLX egress policy path is not a directory")
	for path in (manifest_path, owner_path):
		if path.is_symlink() or (path.exists() and not path.is_file()):
			raise RuntimeError("URLX egress owner manifest path is unsafe")
	if manifest_path.exists() and owner_path.exists():
		if manifest_path.read_bytes() != owner_path.read_bytes():
			raise RuntimeError("URLX egress owner manifests are ambiguous")
	if manifest_path.exists() or owner_path.exists():
		owner_manifest_path = manifest_path if manifest_path.exists() else owner_path
		try:
			manifest = json.loads(owner_manifest_path.read_text())
		except (OSError, json.JSONDecodeError) as error:
			raise RuntimeError("URLX egress owner manifest is malformed") from error
		if not isinstance(manifest, dict):
			raise RuntimeError("URLX egress owner manifest is malformed")
	try:
		run("nft", "list", "table", "bridge", NFT_TABLE)
		table_exists = True
	except subprocess.CalledProcessError:
		table_exists = False
	return manifest, table_exists


def assert_egress_clients_stopped(services: set[str]) -> None:
	clients = egress_clients_to_stop(services)
	if clients:
		raise RuntimeError(
			"URLX egress clients must be stopped before invalidating policy: "
			f"{', '.join(clients)}"
		)


def nft_table_has_install_marker(table: str, marker: str | None = None) -> bool:
	marker_expression = r"urlx-egress-gate-[a-f0-9]{32}"
	if marker is not None:
		if not re.fullmatch(marker_expression, marker):
			return False
		marker_expression = re.escape(marker)
	marker_line = re.compile(
		rf'(?m)^[ \t]*comment[ \t]+"{marker_expression}"[ \t]*;?[ \t]*$'
	)
	return marker_line.search(table) is not None


def invalidate_runtime_policy(policy_dir: Path, project: str, services: set[str]) -> None:
	assert_egress_clients_stopped(services)
	manifest, table_exists = gate_owner_state(policy_dir)
	assert_gate_owner(project, manifest, table_exists)
	if manifest is not None and not gate_owner_manifest_is_valid(manifest, project):
		raise RuntimeError("URLX egress owner manifest is invalid; refusing policy invalidation")

	if table_exists:
		table = run("nft", "list", "table", "bridge", NFT_TABLE)
		if not nft_table_has_install_marker(table):
			raise RuntimeError("URLX egress table has no verified install marker; refusing policy invalidation")

	ready_path = policy_dir / "ready.json"
	owner_path = policy_dir / OWNER_SIDECAR
	if ready_path.exists():
		os.replace(ready_path, owner_path)
	(policy_dir / "ready.json.tmp").unlink(missing_ok=True)
	if table_exists:
		run("nft", "delete", "table", "bridge", NFT_TABLE)
	owner_path.unlink(missing_ok=True)


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


def container_netns(container: dict) -> str:
	"""Read a container's network namespace through the host procfs safely."""
	container_id = container.get("Id", "")
	state = container.get("State", {})
	pid = state.get("Pid")
	started_at = state.get("StartedAt")
	if (
		not re.fullmatch(r"[a-f0-9]{64}", container_id)
		or state.get("Running") is not True
		or not isinstance(pid, int)
		or isinstance(pid, bool)
		or pid <= 0
		or not started_at
	):
		raise RuntimeError("Cannot identify the running URLX container network namespace")

	netns = os.readlink(f"/proc/{pid}/ns/net")
	if not re.fullmatch(r"net:\[\d+\]", netns):
		raise RuntimeError("Host returned an invalid container network namespace identity")

	# The PID can disappear or be reused while procfs is read. Docker's start
	# timestamp and PID must still identify the same running container afterward.
	assert_container_identity_current(container)
	return netns


def assert_container_identity_current(container: dict) -> None:
	container_id = container.get("Id", "")
	state = container.get("State", {})
	inspected = json.loads(run("docker", "inspect", container_id))
	if not isinstance(inspected, list) or len(inspected) != 1:
		raise RuntimeError("Docker did not return the expected URLX container identity")
	latest = inspected[0]
	latest_state = latest.get("State", {})
	if (
		latest.get("Id") != container_id
		or latest_state.get("Running") is not True
		or latest_state.get("Pid") != state.get("Pid")
		or latest_state.get("StartedAt") != state.get("StartedAt")
	):
		raise RuntimeError("URLX container changed while preparing its network policy")


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
		if network.get("Id") != network_id:
			raise RuntimeError(f"Docker returned the wrong URLX network identity for {network_name}")
		if network.get("EnableIPv6"):
			raise RuntimeError(f"IPv6 must be disabled on URLX network {network_name}")
		networks[network_id] = {
			"networkId": network_id,
			"ip": ip,
			"mac": mac,
			"name": network_name,
			"actualName": network.get("Name"),
			"internal": bool(network.get("Internal")),
			"ipv6": bool(network.get("EnableIPv6")),
			"driver": network.get("Driver"),
			"labels": network.get("Labels") or {},
			"members": sorted((network.get("Containers") or {}).keys()),
			"bridge": network.get("Options", {}).get("com.docker.network.bridge.name")
			or f"br-{network_id[:12]}",
		}
	if not networks:
		raise RuntimeError(f"No IPv4 network addresses found for {service}")
	return {
		"container": container,
		"containerId": container_id,
		"hostname": container["Config"].get("Hostname", ""),
		"netns": container_netns(container),
		"networks": networks,
	}


def ingress_endpoint(service: dict, service_name: str) -> dict:
	endpoints = [
		endpoint
		for endpoint in service["networks"].values()
		if endpoint["name"] == host_ingress_network_name()
	]
	if len(endpoints) != 1:
		raise RuntimeError(f"{service_name} must have exactly one URLX host-ingress endpoint")
	return endpoints[0]


def assert_host_ingress_contract(services: dict[str, dict]) -> None:
	known_network_members: dict[str, dict[str, dict]] = {}
	for service_name, service in services.items():
		for network_id, endpoint in service["networks"].items():
			known_network_members.setdefault(network_id, {})[service["containerId"]] = endpoint
		ingress = [
			endpoint
			for endpoint in service["networks"].values()
			if endpoint["name"] == host_ingress_network_name()
		]
		if service_name in HOST_INGRESS_PORTS:
			if len(ingress) != 1:
				raise RuntimeError(f"{service_name} must have exactly one URLX host-ingress endpoint")
			network = ingress[0]
			if (
				network["internal"]
				or network["ipv6"]
				or network["driver"] != "bridge"
				or network["actualName"] != host_ingress_network_name()
				or network["labels"].get("com.docker.compose.project") != COMPOSE_PROJECT
				or network["labels"].get("com.docker.compose.network") != "host-ingress"
			):
				raise RuntimeError("URLX host-ingress network is not the expected project-owned bridge")
			if any(
				endpoint is not network and not endpoint["internal"]
				for endpoint in service["networks"].values()
			):
				raise RuntimeError(f"Service {service_name} has an unexpected external network")
			assert_host_port_published(service_name, service)
		else:
			if ingress:
				raise RuntimeError(f"Unexpected URLX host-ingress endpoint on {service_name}")
			if service_name == "egress-proxy":
				proxy_outbound = [
					endpoint
					for endpoint in service["networks"].values()
					if endpoint["name"] == f"{COMPOSE_PROJECT}_proxy-outbound"
				]
				if (
					len(proxy_outbound) != 1
					or proxy_outbound[0]["internal"]
					or proxy_outbound[0]["driver"] != "bridge"
					or proxy_outbound[0]["ipv6"]
					or proxy_outbound[0]["labels"].get("com.docker.compose.project") != COMPOSE_PROJECT
					or proxy_outbound[0]["labels"].get("com.docker.compose.network") != "proxy-outbound"
				):
					raise RuntimeError("proxy-outbound must be the owned project bridge")
			if any(not endpoint["internal"] for endpoint in service["networks"].values()):
				if service_name != "egress-proxy":
					raise RuntimeError(f"Service {service_name} has an unexpected external network")
				for endpoint in service["networks"].values():
					if not endpoint["internal"] and not (
						endpoint["name"] == f"{COMPOSE_PROJECT}_proxy-outbound"
						and endpoint["driver"] == "bridge"
						and endpoint["labels"].get("com.docker.compose.project") == COMPOSE_PROJECT
						and endpoint["labels"].get("com.docker.compose.network") == "proxy-outbound"
					):
						raise RuntimeError("Egress proxy has an unexpected external network")
				if sum(not endpoint["internal"] for endpoint in service["networks"].values()) != 1:
					raise RuntimeError("Egress proxy must have exactly one external network")
	for service_name in HOST_INGRESS_PORTS:
		if service_name not in services:
			raise RuntimeError(f"Required published service is missing: {service_name}")
	ingress_networks = {
		ingress_endpoint(services[service_name], service_name)["networkId"]:
		ingress_endpoint(services[service_name], service_name)
		for service_name in HOST_INGRESS_PORTS
	}
	if len(ingress_networks) != 1:
		raise RuntimeError("Published URLX services must share exactly one host-ingress network")
	for network_id, endpoints in known_network_members.items():
		actual_members = set(next(iter(endpoints.values()))["members"])
		if actual_members != set(endpoints):
			name = next(iter(endpoints.values()))["name"]
			raise RuntimeError(f"URLX network {name} has unexpected container attachments")


def assert_network_attachments_current(services: dict[str, dict]) -> None:
	expected: dict[str, dict[str, dict]] = {}
	for service in services.values():
		for network_id, endpoint in service["networks"].items():
			expected.setdefault(network_id, {})[service["containerId"]] = endpoint
	for network_id, endpoints in expected.items():
		inspected = inspect_network(network_id)
		if inspected.get("Id") != network_id:
			raise RuntimeError("URLX network identity changed while preparing the egress policy")
		containers = inspected.get("Containers") or {}
		if set(containers) != set(endpoints):
			raise RuntimeError("URLX network attachments changed while preparing the egress policy")
		for container_id, endpoint in endpoints.items():
			member = containers[container_id]
			address = member.get("IPv4Address", "").partition("/")[0]
			if address != endpoint["ip"] or member.get("MacAddress", "").lower() != endpoint["mac"]:
				raise RuntimeError("URLX network endpoint changed while preparing the egress policy")

def assert_host_port_published(service_name: str, service: dict) -> None:
	target = HOST_INGRESS_PORTS[service_name]
	port_key = f"{target}/tcp"
	bindings = service["container"].get("HostConfig", {}).get("PortBindings", {}).get(port_key)
	published = service["container"].get("NetworkSettings", {}).get("Ports", {}).get(port_key)
	if not isinstance(bindings, list) or len(bindings) != 1 or not isinstance(bindings[0], dict):
		raise RuntimeError(f"{service_name} must configure exactly one loopback published port")
	binding = bindings[0]
	if binding.get("HostIp") != "127.0.0.1" or not str(binding.get("HostPort", "")).isdecimal():
		raise RuntimeError(f"{service_name} published port must bind to 127.0.0.1")
	if (
		not isinstance(published, list)
		or len(published) != 1
		or not isinstance(published[0], dict)
		or published[0].get("HostIp") != "127.0.0.1"
		or published[0].get("HostPort") != binding["HostPort"]
	):
		raise RuntimeError(f"Docker did not publish {service_name} on the configured loopback port")
	if (
		set(service["container"].get("HostConfig", {}).get("PortBindings", {})) != {port_key}
		or set(service["container"].get("NetworkSettings", {}).get("Ports", {})) != {port_key}
	):
		raise RuntimeError(f"{service_name} has unexpected published ports")


def shared_networks(left: dict, right: dict) -> list[str]:
	return sorted(set(left["networks"]) & set(right["networks"]))


def canonicalize_ip_networks(values: list[str]) -> list[str]:
	by_version: dict[int, list[ipaddress.IPv4Network | ipaddress.IPv6Network]] = {4: [], 6: []}
	for value in values:
		network = ipaddress.ip_network(value, strict=False)
		by_version[network.version].append(network)
	return [
		str(network)
		for version in (4, 6)
		for network in ipaddress.collapse_addresses(by_version[version])
	]


def blocked_ipv4_networks(host_addresses: list[str]) -> list[str]:
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
		f"{address}/32"
		for address in host_addresses
		if ipaddress.ip_address(address).version == 4
	)
	return canonicalize_ip_networks(blocked)


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

	blocked = blocked_ipv4_networks(host_addresses)

	lines = [
		"table bridge urlx_egress {",
		f"\tset urlx_containers {{ type ipv4_addr; elements = {{ {', '.join(container_ips)} }} }}",
		f"\tset urlx_blocked4 {{ type ipv4_addr; flags interval; elements = {{ {', '.join(blocked)} }} }}",
		"\tchain input {",
		"\t\ttype filter hook input priority -300; policy accept;",
	]
	for service_name, port in HOST_INGRESS_PORTS.items():
		if service_name not in services:
			continue
		endpoint = ingress_endpoint(services[service_name], service_name)
		lines.append(
			f"\t\tip saddr {endpoint['ip']} ether saddr {endpoint['mac']} "
			f"tcp sport {port} ct direction reply ct state established,related accept"
		)
	lines.extend(
		[
			"\t\tip saddr @urlx_containers drop",
			"\t}",
			"\tchain forward {",
			"\t\ttype filter hook forward priority -300; policy accept;",
			"\t\tct state established,related accept",
		]
	)

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
	for source_name, target_name, port in allowed_edges:
		source = services.get(source_name)
		target = services.get(target_name)
		if not source or not target:
			continue
		for network_id in shared_networks(source, target):
			source_endpoint = source["networks"][network_id]
			target_endpoint = target["networks"][network_id]
			if not source_endpoint["internal"] or not target_endpoint["internal"]:
				continue
			lines.append(
				f"\t\tip saddr {source_endpoint['ip']} ether saddr {source_endpoint['mac']} "
				f"ip daddr {target_endpoint['ip']} ether daddr {target_endpoint['mac']} "
				f"tcp dport {port} ct state new accept"
			)

	proxy = services["egress-proxy"]
	proxy_outbound = [
		endpoint
		for endpoint in proxy["networks"].values()
		if endpoint["name"] == f"{COMPOSE_PROJECT}_proxy-outbound"
	]
	if (
		len(proxy_outbound) != 1
		or proxy_outbound[0]["internal"]
		or proxy_outbound[0]["driver"] != "bridge"
		or proxy_outbound[0]["labels"].get("com.docker.compose.project") != COMPOSE_PROJECT
		or proxy_outbound[0]["labels"].get("com.docker.compose.network") != "proxy-outbound"
	):
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


def install_rules(rules: str) -> tuple[str, str]:
	marker = f"urlx-egress-gate-{secrets.token_hex(16)}"
	rules = rules.replace(
		"table bridge urlx_egress {",
		f'table bridge urlx_egress {{\n\tcomment "{marker}";',
		1,
	)
	if marker not in rules:
		raise RuntimeError("Could not mark URLX egress table ownership")
	try:
		run("nft", "list", "table", "bridge", "urlx_egress")
		rules = "delete table bridge urlx_egress\n" + rules
	except subprocess.CalledProcessError:
		pass
	subprocess.run(["nft", "-f", "-"], input=rules, text=True, check=True)
	return hashlib.sha256(rules.encode("utf-8")).hexdigest(), marker


def rollback_installed_rules(policy_dir: Path, marker: str) -> None:
	"""Remove only the table from this install and invalidate its readiness."""
	try:
		try:
			table = run("nft", "list", "table", "bridge", NFT_TABLE)
		except subprocess.CalledProcessError:
			table = ""
		if nft_table_has_install_marker(table, marker):
			run("nft", "delete", "table", "bridge", NFT_TABLE)
	finally:
		for name in ("ready.json", "ready.json.tmp"):
			(policy_dir / name).unlink(missing_ok=True)


def main() -> None:
	parser = argparse.ArgumentParser()
	parser.add_argument("--policy-dir", type=Path)
	parser.add_argument("--project", required=True)
	parser.add_argument("--check-active-only", action="store_true")
	parser.add_argument("--check-owner-only", action="store_true")
	parser.add_argument("--preflight-only", action="store_true")
	parser.add_argument("--invalidate-runtime-only", action="store_true")
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
	if args.invalidate_runtime_only:
		services = running_service_names(
			compose("ps", "--services", "--status", "running"),
			require_core=False,
		)
		invalidate_runtime_policy(policy_dir, args.project, services)
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

	assert_host_ingress_contract(services)

	rules = make_rules(services, host_addresses)
	for service in services.values():
		assert_container_identity_current(service["container"])
	assert_network_attachments_current(services)
	rule_hash, install_marker = install_rules(rules)
	try:
		for service in services.values():
			assert_container_identity_current(service["container"])
		assert_network_attachments_current(services)
	except Exception:
		rollback_installed_rules(policy_dir, install_marker)
		raise

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
