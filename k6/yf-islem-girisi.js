import http from 'k6/http';
import { check } from 'k6'; 
import { SharedArray } from 'k6/data';
import { Rate, Trend, Counter } from 'k6/metrics';
import { scenario } from 'k6/execution'; 

const errorRate = new Rate('vu_errors');
const responseTime = new Trend('vu_duration');
const errorCounter = new Counter('vu_error_count');

const SCENARIO_NAME = 'yf-islem-girisi';

const csvData = new SharedArray('yf_islem', function () {
    return open('./yf_islem_girisi.csv')
        .replace(/\r/g, '') 
        .split('\n')
        .slice(1) 
        .filter(l => l.trim().length > 0)
        .map(line => line.split(';'));
});

export const options = {
    scenarios: {
        [SCENARIO_NAME]: {
            executor: 'shared-iterations',
            vus: 1,          // 1 Kullanıcı
            iterations: 1000, // 1000 Döngü
            maxDuration: '10m' 
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

const BASE_URL = __ENV.NUROLBANK_BASE_URL;

function getIstanbulTime() {
    const d = new Date();
    const ist = new Date(d.getTime() + (3 * 60 * 60 * 1000));
    return ist.toISOString().replace('Z', '+03:00');
}

export default function () {
    const rowIndex = scenario.iterationInTest % csvData.length;
    const row = csvData[rowIndex];

    // Orijinal CSV verilerini doğrudan kullanıyoruz
    const pPortfolioRefCode = row[0]; // nt1, nt2 vb.
    const pRefCode = row[1];
    const pQuantity = row[2];
    const pPrice = row[3];
    const pAmount = row[4];

    const vuTag = { vu: String(__VU), iteration: String(__ITER) };

    const payload = JSON.stringify({
        portfolioRefCode: pPortfolioRefCode,
        refCode: pRefCode,
        transactionDate: "2025-05-12",
        priceClearingDate: "2025-05-12",
        securitiesClearingDate: "2025-05-12",
        returnDate: "2025-05-12",
        transactionTypeNo: 1,
        isinCode: "TRYYKEM00243",
        currencyType: "TL",
        cashAccountCurrencyType: "TL",
        receptionType: 1,
        marketNo: 101,
        quantity: String(pQuantity),
        price: String(pPrice),
        amount: String(pAmount),
        "commissionRate(1/1000)": null,
        custodyStockExchangeCode: "ALARK",
        brokerageStockExchangeCode: "ALCTL",
        transactionDescription: null
    });

    const params = {
        headers: { 
            'X-Api-Key': '__ENV.API_KEY', 
            'Content-Type': 'application/json'
        },
        timeout: '60s',
        tags: vuTag
    };

    const start = new Date().getTime();
    
    const url = `${BASE_URL}/infleks-inx-api/api/v1/nurolbank/basic/fn/transaction/fundTransactions`;
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
            portfolioRefCode: pPortfolioRefCode,
            refCode: pRefCode,
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