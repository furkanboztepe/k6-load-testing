import http from 'k6/http';
import { check } from 'k6'; 
import { SharedArray } from 'k6/data';
import { Rate, Trend, Counter } from 'k6/metrics';

// --- Custom Metrikler ---
const errorRate = new Rate('vu_errors');
const responseTime = new Trend('vu_duration');
const errorCounter = new Counter('vu_error_count');

const SCENARIO_NAME = 'blokaj-islemi';

// CSV OLMADIĞI İÇİN PORTFÖY HAVUZUNDAN GERÇEK KODLARI ÇEKİYORUZ
const portfolioPool = new SharedArray('portfoy_havuzu', function () {
    return open('./portfolio.csv') 
        .replace(/\r/g, '') 
        .split('\n')
        .slice(1) 
        .filter(l => l.trim().length > 0)
        .map(line => line.split(';'));
});

export const options = {
    scenarios: {
        [SCENARIO_NAME]: {
            executor: 'constant-arrival-rate',
            rate: 20, // JMeter'daki ayarınız farklıysa burayı güncelleyin
            timeUnit: '1s',
            duration: '50s',
            preAllocatedVUs: 100, 
            maxVUs: 1000, 
        }
    },
    thresholds: {
        vu_errors: ['rate<0.05'],
        vu_duration: ['p(95)<30000'],
        http_req_duration: ['p(95)<30000'],
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
    // 1. HAVUZDAN RASTGELE BİR PORTFÖY SEÇİMİ
    const randomRow = portfolioPool[Math.floor(Math.random() * portfolioPool.length)];
    const pPortfolioRefCode = randomRow[2]; // yy2001 vb.
    
    // 2. ÇAKIŞMAYAN DİNAMİK REFERANS KODU ÜRETİMİ (Örn: BLK-1-5-1712345678)
    const dynamicRefCode = `BLK-${__VU}-${__ITER}-${new Date().getTime()}`;

    const vuTag = { vu: String(__VU), iteration: String(__ITER) };

    // SİZİN GÖNDERDİĞİNİZ KUSURSUZ PAYLOAD
    const payload = JSON.stringify({
        "portfolioRefCode": pPortfolioRefCode,
        "refCode": dynamicRefCode,
        "transactionDate": "2025-11-14",
        "priceClearingDate": "2025-11-14",
        "securitiesClearingDate": "2025-11-14",
        "returnDate": "2025-11-14",
        "transactionTypeNo": 1,
        "isinCode": "TRYYKEM00029",
        "currencyType": "TL",
        "cashAccountCurrencyType": "TL",
        "receptionType": 1,
        "marketNo": 101,
        "quantity": 2000,
        "price": 2,
        "amount": 4000,
        "commissionRate(1/1000)": null,
        "custodyStockExchangeCode": "ALARK",
        "brokerageStockExchangeCode": "ALCTL",
        "transactionDescription": null
    });

    const params = {
        headers: { 
            'X-Api-Key': __ENV.API_KEY, 
            'Content-Type': 'application/json',
            'pmcCode': __ENV.PMC_CODE,
            'token': __ENV.API_TOKEN
        },
        timeout: '60s',
        tags: vuTag
    };

    const start = new Date().getTime();
    
    const url = `${BASE_URL}/infleks-inx-api/api/v1/hedefyatirim/basic/fn/fundTransactionsWithBlockage`;
    
    const res = http.post(url, payload, params);
    
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
            portfolioCode: pPortfolioRefCode,
            generatedRefCode: dynamicRefCode,
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