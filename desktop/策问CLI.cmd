@echo off
chcp 65001 >nul
setlocal
rem JSON 正文通过文件传入，命令行只传项目身份和文件路径。
set ELECTRON_RUN_AS_NODE=1
"%~dp0策问 Designform.exe" "%~dp0resources\runtime\cli.js" %*
