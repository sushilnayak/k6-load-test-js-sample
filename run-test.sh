#!/bin/bash

# run-test.sh
echo "Starting load test..."
k6 run --out json=k6-output.json test.js

echo "Generating HTML report..."
node report-generator.js

echo "Test complete! Opening report..."
# For Linux
xdg-open load-test-report.html 2>/dev/null || \
# For macOS
open load-test-report.html 2>/dev/null || \
# For Windows
start load-test-report.html 2>/dev/null
