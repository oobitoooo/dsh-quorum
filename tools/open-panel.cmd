@echo off
rem Open the dsh-quorum control panel.
rem Reuses a running panel (including the one inside DSH); otherwise starts a standalone one.
chcp 65001 >nul
setlocal
set "BASE=%~dp0"
set "NODE=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
start "dsh-quorum panel" /min "%NODE%" "%BASE%..\bin\panel.mjs" --port 7845
