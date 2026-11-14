# Starts ASX-sim locally: the FastAPI backend and the React frontend, each in its own window,
# then opens the app in your browser. Run from anywhere:
#
#     powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
#
# Close the two server windows to stop the app.

$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path "$root\frontend\node_modules")) {
    Write-Host "First run: installing frontend packages..."
    Push-Location "$root\frontend"
    npm install
    Pop-Location
}

Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$root\backend'; uv run uvicorn asxsim.api.app:app --reload --port 8000"
)
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$root\frontend'; npm run dev"
)

Write-Host "Starting servers..."
Start-Sleep -Seconds 5
Start-Process "http://localhost:5173"
