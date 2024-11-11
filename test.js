import http from 'k6/http';
import {check, sleep} from 'k6';
import {Counter, Rate, Trend} from 'k6/metrics';

// Custom metrics
const customTrend = new Trend('custom_trend');
const errorRate = new Rate('errors');
const customCounter = new Counter('custom_counter');

export const options = {
    stages: [
        {duration: '30s', target: 20},  // Ramp up
        {duration: '1m', target: 20},   // Stay at peak
        {duration: '30s', target: 0},   // Ramp down
    ],
    thresholds: {
        http_req_duration: ['p(95)<500'], // 95% of requests should be below 500ms
        'http_req_duration{staticAsset:yes}': ['p(95)<100'], // 95% of static asset requests should be below 100ms
    },
};

export default function () {
    const params = {
        headers: {
            'Authorization': 'Bearer your-secret-token-123',
        },
    };

    // Test different endpoints
    const responses = {
        users: http.get('http://localhost:3000/users', params),
        products: http.get('http://localhost:3000/products', params),
        slow: http.get('http://localhost:3000/slow-endpoint', params),
        health: http.get('http://localhost:3000/health'),
    };

    // Record custom metrics
    customTrend.add(responses.users.timings.duration);
    customCounter.add(1);

    // Check responses
    check(responses.users, {
        'users status 200': (r) => r.status === 200,
    }) || errorRate.add(1);

    check(responses.products, {
        'products status 200': (r) => r.status === 200,
    }) || errorRate.add(1);

    sleep(1);
}
