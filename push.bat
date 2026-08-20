@echo off
cd /d "%~dp0"
echo ===================================
echo   Data Portal dashboard repo: %cd%
echo ===================================
echo.
echo [1/4] Checking changes...
git add -A
echo.
set MSG=
set /p MSG=Enter commit message (press Enter for default):
if "%MSG%"=="" set MSG=update dashboard
echo.
echo [2/4] Committing...
git commit -m "%MSG%"
echo.
echo [3/4] Pulling latest from remote...
git pull origin main --no-edit
if errorlevel 1 (
  echo.
  echo !! Pull failed. There may be a conflict.
  echo !! Take a screenshot of this window and send it to Claude.
  pause
  exit /b 1
)
echo.
echo [4/4] Pushing to remote...
git push
if errorlevel 1 (
  echo.
  echo !! Push failed. Take a screenshot of this window and send it to Claude.
  pause
  exit /b 1
)
echo.
echo ===================================
echo   Done! Changes are now on GitHub.
echo ===================================
pause
