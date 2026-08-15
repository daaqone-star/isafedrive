@echo off
title iSafedrive
echo ============================================
echo   iSafedrive - starting...
echo ============================================
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python not found. Install it from https://python.org
  pause
  exit /b 1
)

echo Installing dependencies...
python -m pip install -r requirements.txt

echo Starting server at http://127.0.0.1:5000
echo Press Ctrl+C to stop.
python run.py

pause
