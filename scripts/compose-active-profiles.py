#!/usr/bin/env python3
"""Read only Compose's resolved profile selection from config --environment."""

from __future__ import annotations

import sys


def profiles_from_environment(output: str) -> str:
	values = [
		line.partition("=")[2]
		for line in output.splitlines()
		if line.partition("=")[0] == "COMPOSE_PROFILES"
	]
	if len(values) > 1:
		raise ValueError("Compose reported COMPOSE_PROFILES more than once")
	return values[0] if values else ""


if __name__ == "__main__":
	try:
		print(profiles_from_environment(sys.stdin.read()))
	except ValueError as error:
		print(f"Compose profile discovery failed: {error}", file=sys.stderr)
		sys.exit(1)
