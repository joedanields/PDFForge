#!/usr/bin/env bash
# Run every quality gate (lint, format, types, tests) for engine, UI and Rust.
# Exits non-zero if any gate fails; prints a summary at the end.
#
#   bash scripts/check.sh            # everything
#   bash scripts/check.sh --no-rust  # skip the (slow) Rust gates
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
rust=1
[[ "${1:-}" == "--no-rust" ]] && rust=0
failed=()

gate() {
  local name="$1"
  shift
  printf '== %s\n' "$name"
  if ! "$@"; then
    failed+=("$name")
  fi
}

cd "$root/engine" || exit 1
gate "engine: ruff" uv run ruff check .
gate "engine: black" uv run black --check -q .
gate "engine: mypy" uv run mypy
gate "engine: pytest" uv run pytest -q -n auto

cd "$root/app" || exit 1
gate "ui: typecheck" pnpm -s typecheck
gate "ui: eslint" pnpm -s lint
gate "ui: prettier" pnpm -s format:check
gate "ui: vitest" pnpm -s test

if ((rust)); then
  cd "$root/app/src-tauri" || exit 1
  gate "rust: fmt" cargo fmt --check
  gate "rust: clippy" cargo clippy -q --all-targets -- -D warnings
  gate "rust: tests" cargo test -q
fi

echo
if ((${#failed[@]})); then
  printf 'FAILED: %s\n' "${failed[@]}"
  exit 1
fi
echo "ALL CHECKS PASSED"
