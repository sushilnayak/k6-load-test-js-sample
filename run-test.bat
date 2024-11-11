@echo off
echo Starting load test...

REM Run k6 test and output JSON
k6 run --out json=k6-output.json test.js

echo Generating HTML report...
node report-generator.js

echo Test complete! Opening report...
start "" "load-test-report.html"

echo.
echo Press any key to exit...
pause > nul
