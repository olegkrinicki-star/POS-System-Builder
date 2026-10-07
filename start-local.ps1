# Локальный запуск POS-приложения для тестирования.
# Читает секреты из .env, при необходимости собирает проект и поднимает сервер.
# Откройте http://localhost:10000 — PIN 0000 (админ) или 1111 (работник).
# Остановка: закройте окно консоли или Ctrl+C.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- Загрузка переменных из .env (не попадает в git) ---
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $i = $line.IndexOf("=")
            $name = $line.Substring(0, $i).Trim()
            $value = $line.Substring($i + 1).Trim()
            Set-Item -Path "env:$name" -Value $value
        }
    }
}
$env:PORT = "10000"
# На http://localhost cookie с флагом Secure не работает часть браузеров,
# поэтому для локального теста NODE_ENV не production.
Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue

# --- Сборка при необходимости ---
if (-not (Test-Path (Join-Path $root "artifacts\api-server\dist\index.mjs"))) {
    Write-Host "Собираю бэкенд..."
    pnpm --filter @workspace/api-server run build
}
if (-not (Test-Path (Join-Path $root "artifacts\maradi-pos\dist\public\index.html"))) {
    Write-Host "Собираю фронтенд..."
    pnpm --filter @workspace/maradi-pos run build
}

Write-Host ""
Write-Host "POS-приложение:  http://localhost:10000"
Write-Host "PIN-коды:       0000 — администратор, 1111 — работник"
Write-Host "Остановка:      закройте это окно (или Ctrl+C)"
Write-Host ""

Set-Location (Join-Path $root "artifacts\api-server")
node --enable-source-maps dist\index.mjs