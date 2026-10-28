from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


module_path = Path(__file__).with_name("compose-active-profiles.py")
spec = importlib.util.spec_from_file_location("compose_active_profiles", module_path)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ComposeActiveProfileTests(unittest.TestCase):
	def test_reads_only_resolved_profile_selection(self) -> None:
		self.assertEqual(
			module.profiles_from_environment(
				"DATABASE_URL=postgresql://private\nCOMPOSE_PROFILES=browser\n"
			),
			"browser",
		)

	def test_empty_or_unset_profile_selection_is_empty(self) -> None:
		self.assertEqual(module.profiles_from_environment("DATABASE_URL=private\n"), "")
		self.assertEqual(module.profiles_from_environment("COMPOSE_PROFILES=\n"), "")

	def test_rejects_ambiguous_duplicate_profile_values(self) -> None:
		with self.assertRaisesRegex(ValueError, "more than once"):
			module.profiles_from_environment(
				"COMPOSE_PROFILES=browser\nCOMPOSE_PROFILES=ingress\n"
			)


if __name__ == "__main__":
	unittest.main()
