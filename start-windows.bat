@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。
  echo 请先安装 Node.js 18 或更高版本，再重新双击此文件。
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\launch.js"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo 启动失败，退出码: %EXIT_CODE%
) else (
  echo.
  echo 服务已停止。
)

pause
exit /b %EXIT_CODE%
