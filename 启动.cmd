@echo off
rem Double-click to build and launch SSH Tool.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1"
if errorlevel 1 pause
