@echo off
chcp 65001 >nul
setlocal
rem 使用策问自带的 Electron Node 运行时，不依赖用户另行安装 Node。
set ELECTRON_RUN_AS_NODE=1
"%~dp0策问 Designform.exe" "%~dp0resources\runtime\mcp.js" %*
