"""Nạp plugin như Hermes nạp thư mục plugin: một gói tên tổng hợp, ``import`` tương đối bên trong.

Tên thư mục ``hermes-session-reset`` có gạch ngang nên không import thẳng được.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent
PACKAGE = "ihome_session_reset_under_test"


def _load_package():
    if PACKAGE in sys.modules:
        return sys.modules[PACKAGE]
    spec = importlib.util.spec_from_file_location(
        PACKAGE, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[PACKAGE] = module
    spec.loader.exec_module(module)
    return module


plugin = _load_package()
policy = importlib.import_module(f"{PACKAGE}.policy")
hook = importlib.import_module(f"{PACKAGE}.hook")
