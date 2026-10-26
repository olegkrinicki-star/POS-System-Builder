#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Package name in lib/db/package.json is @workspace/db; `--filter db` matched
# nothing and, with `set -e`, made every post-merge hook fail.
pnpm --filter @workspace/db run push
