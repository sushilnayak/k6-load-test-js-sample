const fs = require('fs');

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDuration(ms) {
    if (ms < 1) {
        return (ms * 1000).toFixed(2) + ' μs';
    } else if (ms < 1000) {
        return ms.toFixed(2) + ' ms';
    } else if (ms < 60000) {
        return (ms / 1000).toFixed(2) + ' s';
    } else {
        return (ms / 60000).toFixed(2) + ' m';
    }
}

function getMetricUnit(metricName) {
    const metricUnits = {
        http_req_duration: 'time',
        http_req_waiting: 'time',
        http_req_connecting: 'time',
        http_req_tls_handshaking: 'time',
        http_req_sending: 'time',
        http_req_receiving: 'time',
        http_reqs: 'count',
        data_sent: 'data',
        data_received: 'data',
        iteration_duration: 'time',
        iterations: 'count',
        vus: 'count',
        vus_max: 'count',
        checks: 'count',
    };
    return metricUnits[metricName] || '';
}

function formatMetricValue(value, unit) {
    switch (unit) {
        case 'time':
            return formatDuration(value);
        case 'data':
            return formatBytes(value);
        case 'count':
            return value.toLocaleString();
        default:
            return value.toFixed(2);
    }
}

function processK6Output(filePath) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    const metrics = {};
    const samples = {};
    const timeseriesData = {
        timestamps: [],
        vus: [],
        responseTime: [],
        requests: [],
        dataTransfer: [],
        statusCodes: {}
    };
    const successfulResponses = []; // Track only successful response times
    let testStartTime = null;
    let testEndTime = null;

    lines.forEach(line => {
        if (!line.trim()) return;

        try {
            const data = JSON.parse(line);

            if (data.type === 'Point' && data.data.time) {
                const timestamp = new Date(data.data.time);
                const timeInSeconds = timestamp.getTime() / 1000;

                if (!testStartTime || timestamp < testStartTime) testStartTime = timestamp;
                if (!testEndTime || timestamp > testEndTime) testEndTime = timestamp;

                // Track status codes
                if (data.metric === 'http_reqs' && data.data.tags && data.data.tags.status) {
                    const status = data.data.tags.status;
                    timeseriesData.statusCodes[status] = (timeseriesData.statusCodes[status] || 0) + 1;
                }

                // Collect timeseries data
                if (data.metric === 'vus') {
                    timeseriesData.timestamps.push(timeInSeconds);
                    timeseriesData.vus.push(data.data.value);
                } else if (data.metric === 'http_req_duration') {
                    // Only track response time for successful requests (status 200)
                    if (data.data.tags && data.data.tags.status === '200') {
                        successfulResponses.push({
                            timestamp: timeInSeconds,
                            value: data.data.value
                        });
                    }
                } else if (data.metric === 'http_reqs') {
                    timeseriesData.requests.push({
                        timestamp: timeInSeconds,
                        value: data.data.value,
                        status: data.data.tags?.status
                    });
                } else if (data.metric === 'data_received') {
                    // Only track data transfer for successful requests
                    if (data.data.tags && data.data.tags.status === '200') {
                        timeseriesData.dataTransfer.push({
                            timestamp: timeInSeconds,
                            value: data.data.value
                        });
                    }
                }
            }

            // Process metric definitions
            if (data.type === 'Metric') {
                metrics[data.data.name] = {
                    type: data.data.type,
                    contains: data.data.contains,
                    values: [],
                    stats: {},
                    unit: getMetricUnit(data.data.name)
                };
            }

            // Process point data, only including successful responses in metrics
            if (data.type === 'Point') {
                const metricName = data.metric;
                if (metricName === 'http_req_duration' && (!data.data.tags || data.data.tags.status !== '200')) {
                    return; // Skip non-200 responses for duration metrics
                }
                if (!samples[metricName]) {
                    samples[metricName] = [];
                }
                samples[metricName].push(data.data.value);
            }
        } catch (e) {
            console.error('Error processing line:', e);
        }
    });

    // Use successful responses for response time calculations
    timeseriesData.responseTime = successfulResponses;

    // Calculate statistics for each metric
    Object.keys(samples).forEach(metricName => {
        const values = samples[metricName].sort((a, b) => a - b);
        const len = values.length;

        if (len > 0) {
            metrics[metricName].stats = {
                min: values[0],
                max: values[len - 1],
                avg: values.reduce((a, b) => a + b, 0) / len,
                med: len % 2 === 0 ?
                    (values[len / 2 - 1] + values[len / 2]) / 2 :
                    values[Math.floor(len / 2)],
                p90: values[Math.floor(len * 0.9)],
                p95: values[Math.floor(len * 0.95)],
                p99: values[Math.floor(len * 0.99)],
                count: len
            };
        }
    });

    // Process timeseries data for response time distribution (successful responses only)
    const responseTimeBuckets = {};
    successfulResponses.forEach(point => {
        const bucket = Math.floor(point.value / 100) * 100; // 100ms buckets
        responseTimeBuckets[bucket] = (responseTimeBuckets[bucket] || 0) + 1;
    });

    timeseriesData.responseTimeDistribution = {
        buckets: Object.keys(responseTimeBuckets).map(Number),
        counts: Object.values(responseTimeBuckets)
    };

    return {
        metrics,
        testDuration: testEndTime - testStartTime,
        timeseriesData
    };
}

function generateHTML(data) {
    const {metrics, testDuration, timeseriesData} = data;
    const timestamp = new Date().toISOString();

    return `
<!DOCTYPE html>
<html>
<head>
    <title>Load Test Report - ${timestamp}</title>
    <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
    <style>
        body {
            font-family: Arial, sans-serif;
            margin: 0;
            padding: 20px;
            background: #f5f5f5;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 0 10px rgba(0,0,0,0.1);
        }
        .metric-card {
            background: white;
            padding: 15px;
            margin: 10px 0;
            border-radius: 4px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .metric-title {
            font-size: 1.2em;
            font-weight: bold;
            margin-bottom: 10px;
            color: #333;
        }
        .metric-type {
            font-size: 0.9em;
            color: #666;
            margin-left: 10px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 10px;
            margin-top: 10px;
        }
        .stat-item {
            background: #f8f9fa;
            padding: 10px;
            border-radius: 4px;
        }
        .stat-label {
            font-weight: bold;
            color: #666;
        }
        .summary {
            margin: 20px 0;
            padding: 15px;
            background: #e9ecef;
            border-radius: 4px;
        }
        .http-metrics {
            margin-top: 20px;
            padding: 15px;
            background: #f8f9fa;
            border-radius: 4px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 10px;
        }
        th, td {
            padding: 8px;
            text-align: left;
            border-bottom: 1px solid #dee2e6;
        }
        th {
            background-color: #f8f9fa;
        }
        .chart-container {
            margin: 20px 0;
            padding: 15px;
            background: white;
            border-radius: 4px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .chart {
            width: 100%;
            height: 400px;
        }
        .charts-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 20px;
            margin-top: 20px;
        }
        @media (max-width: 1200px) {
            .charts-grid {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Load Test Report</h1>
        
        <div class="summary">
            <h2>Test Summary</h2>
            <p>Test Start: ${new Date(timestamp).toLocaleString()}</p>
            <p>Test Duration: ${formatDuration(testDuration)}</p>
            ${metrics.http_reqs ?
        `<p>Total Requests: ${metrics.http_reqs.stats.count.toLocaleString()}</p>
                 <p>Successful Requests (200): ${(data.timeseriesData.statusCodes['200'] || 0).toLocaleString()}</p>
                 <p>Failed Requests: ${(metrics.http_reqs.stats.count - (data.timeseriesData.statusCodes['200'] || 0)).toLocaleString()}</p>
                 <p>Success Rate: ${((data.timeseriesData.statusCodes['200'] || 0) / metrics.http_reqs.stats.count * 100).toFixed(2)}%</p>` :
        ''}
            ${metrics.http_req_duration ?
        `<p>Average Response Time (Success Only): ${formatDuration(metrics.http_req_duration.stats.avg)}</p>` :
        ''}
        </div>

        <!-- Response Time Metrics -->
        <div class="metric-section">
            <h2>Response Time Metrics</h2>
            <table>
                <thead>
                    <tr>
                        <th>Metric</th>
                        <th>Min</th>
                        <th>Max</th>
                        <th>Avg</th>
                        <th>Med</th>
                        <th>p90</th>
                        <th>p95</th>
                        <th>p99</th>
                    </tr>
                </thead>
                <tbody>
                    ${Object.entries(metrics)
        .filter(([name, data]) => data.unit === 'time')
        .map(([name, data]) => `
                            <tr>
                                <td>${name}</td>
                                ${['min', 'max', 'avg', 'med', 'p90', 'p95', 'p99']
            .map(stat => `<td>${formatDuration(data.stats[stat])}</td>`)
            .join('')}
                            </tr>
                        `).join('')}
                </tbody>
            </table>
        </div>

        <!-- Data Transfer Metrics -->
        <div class="metric-section">
            <h2>Data Transfer Metrics</h2>
            <table>
                <thead>
                    <tr>
                        <th>Metric</th>
                        <th>Min</th>
                        <th>Max</th>
                        <th>Avg</th>
                        <th>Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${Object.entries(metrics)
        .filter(([name, data]) => data.unit === 'data')
        .map(([name, data]) => `
                            <tr>
                                <td>${name}</td>
                                <td>${formatBytes(data.stats.min)}</td>
                                <td>${formatBytes(data.stats.max)}</td>
                                <td>${formatBytes(data.stats.avg)}</td>
                                <td>${formatBytes(data.stats.avg * metrics.http_reqs.stats.count)}</td>
                            </tr>
                        `).join('')}
                </tbody>
            </table>
        </div>

        <!-- Charts Section -->
        <h2>Performance Charts</h2>
        <div class="charts-grid">
            <div class="chart-container">
                <h3>Virtual Users & Response Time Over Time</h3>
                <div id="vuChart" class="chart"></div>
            </div>
            <div class="chart-container">
                <h3>Response Time Distribution</h3>
                <div id="responseTimeDistribution" class="chart"></div>
            </div>
            <div class="chart-container">
                <h3>Response Time Percentiles</h3>
                <div id="percentileChart" class="chart"></div>
            </div>
            <div class="chart-container">
                <h3>Requests Per Second</h3>
                <div id="rpsChart" class="chart"></div>
            </div>
            <div class="chart-container">
                <h3>HTTP Status Code Distribution</h3>
                <div id="statusCodesChart" class="chart"></div>
            </div>
        </div>

        <script>
            // VU and Response Time Chart
            const vuTrace = {
                x: ${JSON.stringify(timeseriesData.timestamps)},
                y: ${JSON.stringify(timeseriesData.vus)},
                name: 'Virtual Users',
                type: 'scatter',
                yaxis: 'y2',
                line: {color: '#1f77b4'}
            };

            const responseTimeTrace = {
                x: ${JSON.stringify(timeseriesData.responseTime.map(p => p.timestamp))},
                y: ${JSON.stringify(timeseriesData.responseTime.map(p => p.value))},
                name: 'Response Time (ms)',
                type: 'scatter',
                mode: 'markers',
                marker: {
                    size: 4,
                    color: '#ff7f0e',
                    opacity: 0.5
                }
            };

            const vuLayout = {
                title: 'Virtual Users & Response Time',
                xaxis: {title: 'Time'},
                yaxis: {title: 'Response Time (ms)'},
                yaxis2: {
                    title: 'Virtual Users',
                    overlaying: 'y',
                    side: 'right'
                },
                showlegend: true
            };

            Plotly.newPlot('vuChart', [responseTimeTrace, vuTrace], vuLayout);

            // Response Time Distribution
            const distData = {
                x: ${JSON.stringify(timeseriesData.responseTimeDistribution.buckets)},
                y: ${JSON.stringify(timeseriesData.responseTimeDistribution.counts)},
                type: 'bar',
                name: 'Response Time Distribution',
                marker: {
                    color: '#2ca02c'
                }
            };

            const distLayout = {
                title: 'Response Time Distribution',
                xaxis: {title: 'Response Time (ms)'},
                yaxis: {title: 'Number of Requests'},
                bargap: 0.1
            };

            Plotly.newPlot('responseTimeDistribution', [distData], distLayout);

            // Percentile Chart
            const percentiles = Array.from({length: 100}, (_, i) => i + 1);
            const sortedResponseTimes = ${JSON.stringify(timeseriesData.responseTime.map(p => p.value).sort((a, b) => a - b))};
            
            const percentileValues = percentiles.map(p => {
                const index = Math.floor((p / 100) * sortedResponseTimes.length);
                return sortedResponseTimes[index];
            });

            const percentileTrace = {
                x: percentiles,
                y: percentileValues,
                type: 'scatter',
                mode: 'lines',
                name: 'Response Time Percentiles',
                line: {
                    shape: 'spline',
                    color: '#d62728'
                }
            };

            const percentileLayout = {
                title: 'Response Time Percentiles',
                xaxis: {
                    title: 'Percentile',
                    ticksuffix: 'th'
                },
                yaxis: {title: 'Response Time (ms)'},
                annotations: [
                    {
                        x: 90,
                        y: percentileValues[89],
                        text: 'P90',
                        showarrow: true,
                        arrowhead: 2,
                        ax: 30,
                        ay: -30
                    },
                    {
                        x: 95,
                        y: percentileValues[94],
                        text: 'P95',
                        showarrow: true,
                        arrowhead: 2,
                        ax: 30,
                        ay: -30
                    },
                    {
                        x: 99,
                        y: percentileValues[98],
                        text: 'P99',
                        showarrow: true,
                        arrowhead: 2,
                        ax: 30,
                        ay: -30
                    }
                ]
            };

            Plotly.newPlot('percentileChart', [percentileTrace], percentileLayout);

            // Requests Per Second
            const rpsData = [];
            let currentSecond = Math.floor(${JSON.stringify(timeseriesData.timestamps)}[0]);
            let requestCount = 0;

            ${JSON.stringify(timeseriesData.timestamps)}.forEach((timestamp, index) => {
                if (Math.floor(timestamp) === currentSecond) {
                    requestCount++;
                } else {
                    rpsData.push({
                        timestamp: currentSecond,
                        rps: requestCount
                    });
                    currentSecond = Math.floor(timestamp);
                    requestCount = 1;
                }
            });

            const rpsTrace = {
                x: rpsData.map(d => d.timestamp),
                y: rpsData.map(d => d.rps),
                type: 'scatter',
                mode: 'lines',
                name: 'Requests per Second',
                line: {
                    shape: 'spline',
                    color: '#9467bd'
                },
                fill: 'tozeroy',
                fillcolor: 'rgba(148, 103, 189, 0.1)'
            };

            const rpsLayout = {
                title: 'Requests per Second Over Time',
                xaxis: {title: 'Time'},
                yaxis: {
                    title: 'Requests/Second',
                    rangemode: 'tozero'
                }
            };

            Plotly.newPlot('rpsChart', [rpsTrace], rpsLayout);

            // Add responsiveness to charts
            window.addEventListener('resize', function() {
                const chartIds = ['vuChart', 'responseTimeDistribution', 'percentileChart', 'rpsChart'];
                chartIds.forEach(id => {
                    Plotly.relayout(id, {
                        width: document.getElementById(id).clientWidth
                    });
                });
            });
            
            // Status Codes Chart
            const statusCodes = ${JSON.stringify(Object.keys(data.timeseriesData.statusCodes))};
            const statusCounts = ${JSON.stringify(Object.values(data.timeseriesData.statusCodes))};
            
            const statusCodesTrace = {
                x: statusCodes,
                y: statusCounts,
                type: 'bar',
                marker: {
                    color: statusCodes.map(code => code === '200' ? '#2ecc71' : '#e74c3c')
                },
                text: statusCounts.map(String),
                textposition: 'auto',
            };

            const statusCodesLayout = {
                title: 'HTTP Status Code Distribution',
                xaxis: {
                    title: 'Status Code',
                    tickmode: 'array',
                    ticktext: statusCodes.map(code => {
                        const codeMap = {
                            '200': 'OK',
                            '400': 'Bad Request',
                            '401': 'Unauthorized',
                            '403': 'Forbidden',
                            '404': 'Not Found',
                            '500': 'Server Error',
                            '502': 'Bad Gateway',
                            '503': 'Service Unavailable',
                            '504': 'Gateway Timeout'
                        };
                        return code + (codeMap[code] || '');
                    }),
                    tickvals: statusCodes
                },
                yaxis: {
                    title: 'Count',
                    rangemode: 'tozero'
                }
            };

            Plotly.newPlot('statusCodesChart', [statusCodesTrace], statusCodesLayout);

            // Add status codes chart to the resize event handler
            window.addEventListener('resize', function() {
                const chartIds = ['vuChart', 'responseTimeDistribution', 'percentileChart', 'rpsChart', 'statusCodesChart'];
                chartIds.forEach(id => {
                    Plotly.relayout(id, {
                        width: document.getElementById(id).clientWidth
                    });
                });
            });
        </script>
    </div>
</body>
</html>`;
}

// Main execution
try {
    console.log('Processing k6 output...');
    const data = processK6Output('k6-output.json');

    console.log('Generating HTML report...');
    const html = generateHTML(data);

    fs.writeFileSync('load-test-report.html', html);
    console.log('Report generated successfully: load-test-report.html');
} catch (error) {
    console.error('Error generating report:', error);
    process.exit(1);
}
