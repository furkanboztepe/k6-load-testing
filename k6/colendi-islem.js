import http from 'k6/http';
import { check } from 'k6'; 
import { Rate, Trend, Counter } from 'k6/metrics';

// --- Custom Metrikler ---
const errorRate = new Rate('vu_errors');
const responseTime = new Trend('vu_duration');
const errorCounter = new Counter('vu_error_count');

const SCENARIO_NAME = 'colendi-order-cache';

export const options = {
    scenarios: {
        [SCENARIO_NAME]: {
            // JMeter'daki "10 Thread, 1 Loop" ayarının birebir karşılığı
            executor: 'shared-iterations',
            vus: 10,          // Aynı anda 10 Kullanıcı
            iterations: 10,   // Toplam 10 İstek (Kullanıcı başına 1)
            maxDuration: '1m' // Test en fazla 1 dakika sürer
        }
    },
    thresholds: {
        vu_errors: ['rate<0.05'],
        vu_duration: ['p(95)<30000'],
        http_req_duration: ['p(95)<30000'],
    },
    tags: {
        testName: SCENARIO_NAME,
        environment: 'colendi',
    }
};

// .env dosyasından çekilen Colendi Adresi
const BASE_URL = __ENV.COLENDI_BASE_URL;

function getIstanbulTime() {
    const d = new Date();
    const ist = new Date(d.getTime() + (3 * 60 * 60 * 1000));
    return ist.toISOString().replace('Z', '+03:00');
}

// Rastgele Hesap ID'si üretme (Siz isterseniz CSV de okutabilirsiniz)
function getRandomAccountId() {
    // Örneğin 100000 ile 999999 arası bir ID üretir
    return Math.floor(Math.random() * (999999 - 100000 + 1)) + 100000;
}

export default function () {
    const vuTag = { vu: String(__VU), iteration: String(__ITER) };

    // CSV'miz olmadığı için dinamik bir AccountID üretiyoruz
    // Eğer JMeter'da bu statik bir ID ise, kodu şöyle değiştirebilirsiniz: const pAccountId = "SABIT_ID_BURAYA";
    const pAccountId = String(getRandomAccountId());

    // JMeter'da belirtilen headerlar (API Key veya Token eklenecekse burayı düzenleyebilirsiniz)
    const params = {
        headers: { 
            Authorization: 'Bearer a441e623-2290-4779-8ab0-e5f310e87a1a'
        },
        timeout: '60s',
        tags: vuTag
    };

    const start = new Date().getTime();
    
    // JMeter'daki tam GET adresi ve query parametresi (?accountId=...)
    const url = `${BASE_URL}/gate/v1/reports/equity-position?accountId=${pAccountId}`;
    
    const res = http.get(url, params);
    
    const duration = new Date().getTime() - start;

    const success = check(res, {
        'status 200': (r) => r.status === 200,
        'response time < 30s': (r) => r.timings.duration < 30000,
    });

    responseTime.add(duration, vuTag);
    errorRate.add(!success, vuTag);

    if (!success) {
        errorCounter.add(1, vuTag);
        
        console.log(JSON.stringify({
            level: "error",
            event: "request_failed",
            testName: SCENARIO_NAME,
            vu: __VU,
            iteration: __ITER,
            status: res.status,
            duration_ms: duration,
            accountIdSent: pAccountId,
            url: res.url,
            timestamp: getIstanbulTime(),
            errorCode: res.error_code || null,
            errorMessage: res.error || null,
            responseBody: res.body ? res.body.substring(0, 500) : null,
        }));
    }
}

export function handleSummary(data) {
    const summary = {
        testName: SCENARIO_NAME,
        completedAt: getIstanbulTime(),
        metrics: {
            totalRequests: data.metrics.http_reqs?.values?.count,
            failedRequests: data.metrics.http_req_failed?.values?.passes,
            errorRate: data.metrics.vu_errors?.values?.rate,
            p95Duration: data.metrics.vu_duration?.values?.['p(95)'],
            avgDuration: data.metrics.vu_duration?.values?.avg,
            maxVUs: data.metrics.vus_max?.values?.max,
        }
    };

    console.log(JSON.stringify({ level: "info", event: "test_summary", ...summary }));

    return {
        stdout: JSON.stringify(summary, null, 2),
        [`./k6-logs/summary-${SCENARIO_NAME}.json`]: JSON.stringify(summary, null, 2),
    };
}