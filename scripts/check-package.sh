#!/usr/bin/env bash
# Builds, packs into a temp dir, and checks the resulting tarball with
# attw and publint. attw --pack doesn't work with pnpm, so we pack first
# and point attw at the tarball directly.
set -euo pipefail

pnpm build

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

tarball="$(pnpm pack --pack-destination "$tmp_dir" | tail -1)"

pnpm exec attw "$tarball" --profile esm-only
pnpm exec publint
