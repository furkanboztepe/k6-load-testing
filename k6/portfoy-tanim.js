import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Rate, Trend, Counter } from 'k6/metrics';

const errorRate = new Rate('vu_errors');
const responseTime = new Trend('vu_duration');
const errorCounter = new Counter('vu_error_count');

const SCENARIO_NAME = 'portfoy-tanim';

// --- YENİ CSV VERİSİ OKUMA ---
const csvData = new SharedArray('portfoy', function () {
    return open('./Portfoy_tanim_yeni_37.csv') 
        .replace(/\r/g, '') 
        .split('\n')
        // DİKKAT: Yeni dosyanızda başlık (header) olmadığı için .slice(1) komutu KALDIRILDI.
        // Böylece 1. satırdaki (100 numaralı) veriyi de başarıyla okuyacak.
        .filter(l => l.trim().length > 0)
        .map(line => line.split(';'));
});

export const options = {
    scenarios: {
        [SCENARIO_NAME]: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '30s', target: 200 }
            ],
            gracefulRampDown: '0s'
        }
    },
    thresholds: {
        vu_errors: ['rate<0.05'],
        vu_duration: ['p(95)<20000'],
        http_req_duration: ['p(95)<20000'],
    },
    tags: {
        testName: SCENARIO_NAME,
        environment: 'test',
    }
};

const BASE_URL = __ENV.HEDEF_YATIRIM_BASE_URL;

function getIstanbulTime() {
    const d = new Date();
    const ist = new Date(d.getTime() + (3 * 60 * 60 * 1000));
    return ist.toISOString().replace('Z', '+03:00');
}

export default function () {
    // Tüm VU'lara sırayla benzersiz satırları dağıtma
    const rowIndex = (__VU + __ITER) % csvData.length;
    const row = csvData[rowIndex];
    
    // KRİTİK DÜZELTME: Gizli boşluk ve karakterlerin API'yi bozmaması için .trim() eklendi
    const pCode = row[0].trim();
    const pName = row[1].trim();
    const pRefCode = row[2].trim();
    const cRefCode = row[3].trim();

    const vuTag = { vu: String(__VU), iteration: String(__ITER) };

    const payload = JSON.stringify({
        portfolioType: "INDIVIDUAL",
        portfolioCode: pCode,
        portfolioName: pName,
        portfolioStatus: "ACTIVE",
        portfolioRefCode: pRefCode,
        portfolioClass: "FUND",
        portfolioReportNo: "1234",
        customerRefCode: cRefCode,
        pmcCode: "ENE",
        params: [
            {
                paramNo: 2,
                paramValue: "TL"
            }
        ],
        strategyCode: null
    });

    const params = {
        headers: { 
            'X-Api-Key': __ENV.API_KEY || '1234', 
            'Content-Type': 'application/json',
            'pmcCode': __ENV.PMC_CODE || 'ENE',
            'token': __ENV.API_TOKEN || 'ERYTESTENESTEST'
        },
        timeout: '60s',
        tags: vuTag
    };

    const start = new Date().getTime();
    const res = http.post(`${BASE_URL}/infleks-inx-api/api/v1/hedefyatirim/basic/py/definition/portfolio`, payload, params);
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
            portfolioCode: pCode,
            customerRefCode: cRefCode,
            url: res.url,
            timestamp: getIstanbulTime(),
            errorCode: res.error_code || null,
            errorMessage: res.error || null,
            responseBody: res.body ? res.body.substring(0, 500) : null,
        }));
    }

    sleep(Math.random() * 2 + 1);
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