@echo off
REM Claude-Flow MCP Server V3 Startup Script (Windows)
REM
REM Usage:
REM   start-mcp.cmd [options]
REM
REM Options:
REM   --transport <type>   Transport: stdio (default: stdio; only value supported)
REM   --log-level <level>  Log level: debug, info, warn, error (default: info)
REM   --help               Show help

setlocal EnableDelayedExpansion

REM Script directory
set "SCRIPT_DIR=%~dp0"
set "V3_DIR=%SCRIPT_DIR%.."
set "PROJECT_ROOT=%V3_DIR%\.."

REM Default configuration
set "TRANSPORT=stdio"
set "LOG_LEVEL=info"

REM PID file location
set "PID_FILE=%TEMP%\claude-flow-mcp.pid"
set "LOG_FILE=%TEMP%\claude-flow-mcp.log"

REM Override from environment variables
if defined MCP_TRANSPORT set "TRANSPORT=%MCP_TRANSPORT%"
if defined MCP_LOG_LEVEL set "LOG_LEVEL=%MCP_LOG_LEVEL%"

REM Parse arguments
:parse_args
if "%~1"=="" goto :start_server
if "%~1"=="--transport" (
    set "TRANSPORT=%~2"
    shift
    shift
    goto :parse_args
)
if "%~1"=="-t" (
    set "TRANSPORT=%~2"
    shift
    shift
    goto :parse_args
)
if "%~1"=="--log-level" (
    set "LOG_LEVEL=%~2"
    shift
    shift
    goto :parse_args
)
if "%~1"=="-l" (
    set "LOG_LEVEL=%~2"
    shift
    shift
    goto :parse_args
)
if "%~1"=="--help" (
    goto :show_help
)
echo [ERROR] Unknown option: %~1
goto :show_help

:show_help
echo.
echo Claude-Flow MCP Server V3 Startup Script (Windows)
echo.
echo Usage:
echo   start-mcp.cmd [options]
echo.
echo Options:
echo   --transport, -t ^<type^>   Transport: stdio (default: stdio; only value supported)
echo   --log-level, -l ^<level^>  Log level: debug, info, warn, error (default: info)
echo   --help                   Show this help message
echo.
echo Examples:
echo   start-mcp.cmd                          Start with defaults (stdio)
echo.
echo Environment Variables:
echo   MCP_TRANSPORT       Override transport type
echo   MCP_LOG_LEVEL       Override log level
echo.
exit /b 0

:start_server
REM Check for Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed
    exit /b 1
)

REM Server entry point
set "SERVER_ENTRY=%V3_DIR%\mcp\server-entry.ts"

if not exist "%SERVER_ENTRY%" (
    echo [ERROR] Server entry point not found: %SERVER_ENTRY%
    exit /b 1
)

echo [INFO] Starting Claude-Flow MCP Server V3...
echo [INFO]   Transport: %TRANSPORT%
echo [INFO]   Log level: %LOG_LEVEL%
echo [INFO]   Mode: foreground (Ctrl+C to stop)
echo.

REM Start server
npx tsx "%SERVER_ENTRY%" --transport %TRANSPORT% --log-level %LOG_LEVEL%

endlocal
