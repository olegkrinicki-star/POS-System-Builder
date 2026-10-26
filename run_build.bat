@echo off
rem Build the POS web client. This repo is a pnpm workspace: `npm install`
rem inside artifacts/maradi-pos ignores `catalog:`/`workspace:` specifiers and
rem produces a broken tree, so always go through pnpm from the repo root.
cd /d "%~dp0"
call pnpm install --frozen-lockfile || goto :error
call pnpm --filter @workspace/maradi-pos run build || goto :error
echo.
echo Done: artifacts\maradi-pos\dist\public
exit /b 0

:error
echo Build failed.
exit /b 1
