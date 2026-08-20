@echo off
REM Daily collection entrypoint for Windows Task Scheduler (WP-11).
REM
REM ASCII only, on purpose. cmd.exe parses .cmd files in the OEM codepage (CP949 here),
REM not UTF-8, so Korean comments decode to garbage and break parsing. Korean notes for
REM this script live in README.md instead.
REM
REM Reads DATABASE_URL from the repo-root .env so no secret is stored in the repo.
REM Runs `daily --with-tenants`: the tenant table lives only in the notice PDF and is
REM readable from one week before the auction date until that date. Miss the window and
REM it is gone for good (WP-11 section 4-3). Items already scanned are skipped, so in
REM steady state this only costs requests for newly published items.
REM Migrations are NOT run here - schema changes are applied by hand after review.
setlocal
set "HERE=%~dp0"
set "ENVFILE=%HERE%..\..\.env"

if not exist "%ENVFILE%" (
  echo run_daily: %ENVFILE% not found 1>&2
  exit /b 2
)

REM COLLECTOR_JAVA points at a Java 11+ runtime for the PDF table reader
REM (opendataloader-pdf ships a JAR). On this machine the java on PATH is Java 8
REM (C:\Windows\System32\java.exe), which dies with UnsupportedClassVersionError.
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENVFILE%") do (
  if /i "%%A"=="DATABASE_URL" set "DATABASE_URL=%%B"
  if /i "%%A"=="COLLECTOR_JAVA" set "COLLECTOR_JAVA=%%B"
)

if not defined DATABASE_URL (
  echo run_daily: DATABASE_URL not set in .env 1>&2
  exit /b 2
)

REM A reboot leaves Docker Desktop (and the auction-db container) down, and then every
REM collection stage fails on DB connect after long timeouts (observed 2026-08-06: a full
REM run wasted 35 minutes to report 9 stage failures). Bring the DB up before collecting.
REM Sleep uses ping because timeout.exe needs an interactive console and dies under the
REM Task Scheduler.
docker info >nul 2>&1
if not errorlevel 1 goto engine_ready
start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
set /a engine_tries=0
:wait_engine
docker info >nul 2>&1
if not errorlevel 1 goto engine_ready
set /a engine_tries+=1
if %engine_tries% geq 36 (
  echo run_daily: docker engine did not start within 3 minutes 1>&2
  exit /b 3
)
ping -n 6 127.0.0.1 >nul
goto wait_engine
:engine_ready

docker compose -f "%HERE%..\..\docker-compose.yml" up -d db >nul 2>&1
set /a db_tries=0
:wait_db
REM /b: match at line start only - "unhealthy" must not pass as "healthy"
docker inspect --format "{{.State.Health.Status}}" auction-db 2>nul | findstr /b /i /c:"healthy" >nul
if not errorlevel 1 goto db_ready
set /a db_tries+=1
if %db_tries% geq 24 (
  echo run_daily: auction-db did not become healthy within 2 minutes 1>&2
  exit /b 3
)
ping -n 6 127.0.0.1 >nul
goto wait_db
:db_ready

REM A resume or reboot can bring the DB up before DNS is ready, and then every court fails on
REM name resolution (observed 2026-08-13 12:02: 5 stage failures, 136 wasted requests against
REM courtauction with <urlopen error [Errno 11001] getaddrinfo failed>). Wait for the name the
REM collector actually resolves. PowerShell is used instead of ping/nslookup because their
REM failure text is localized and their exit codes are not reliable here.
set /a net_tries=0
:wait_net
powershell -NoProfile -Command "try { [void][System.Net.Dns]::GetHostEntry('www.courtauction.go.kr'); exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto net_ready
set /a net_tries+=1
if %net_tries% geq 24 (
  echo run_daily: courtauction did not resolve within 2 minutes 1>&2
  exit /b 4
)
ping -n 6 127.0.0.1 >nul
goto wait_net
:net_ready

cd /d "%HERE%"
".venv\Scripts\python.exe" -m collector daily --with-tenants >> "%HERE%daily.log" 2>&1
exit /b %ERRORLEVEL%
