import http from 'k6/http';
import { check } from 'k6'; 
import { SharedArray } from 'k6/data';
import { Rate, Trend, Counter } from 'k6/metrics';
import { scenario } from 'k6/execution'; 

const errorRate = new Rate('vu_errors');
const responseTime = new Trend('vu_duration');
const errorCounter = new Counter('vu_error_count');

const SCENARIO_NAME = 'mkstok-servisi';

// 1. Senin içinde 'nt1', 'nt920' yazan orijinal CSV dosyan
const csvData = new SharedArray('mk_sorgu', function () {
    return open('./islem_sonrasi_portfolio.csv')
        .replace(/\r/g, '') 
        .split('\n')
        .slice(1) 
        .filter(l => l.trim().length > 0)
        .map(line => line.split(';'));
});

// 2. Hedef Yatırım sunucusunda GERÇEKTEN var olan portföylerin dosyası (yy2001 vb.)
const portfolioCsv = new SharedArray('portfoy_match', function () {
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
            rate: 20, 
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

// .env dosyasından çekilen adres
const BASE_URL = __ENV.HEDEF_YATIRIM_BASE_URL;

function getIstanbulTime() {
    const d = new Date();
    const ist = new Date(d.getTime() + (3 * 60 * 60 * 1000));
    return ist.toISOString().replace('Z', '+03:00');
}

export default function () {
    const rowIndex = scenario.iterationInTest % csvData.length;
    
    // Senin CSV'ndeki nt920 gibi "sahte" kodları alıyoruz
    const row = csvData[rowIndex];
    const originalCsvCode = row[0].trim(); 

    // SİHİRLİ DOKUNUŞ: Gerçek portföy dosyasından aynı satırdaki GERÇEK kodu (3. sütun) çekiyoruz
    // nt920 yerine sisteme yy2920 gibi gerçek bir kod gidecek!
    const portfoyRow = portfolioCsv[rowIndex % portfolioCsv.length];
    const realPortfolioCode = portfoyRow[2].trim(); 

    const vuTag = { vu: String(__VU), iteration: String(__ITER) };

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
    
    // URL'ye sahte olanı (nt920) değil, GERÇEK olanı (realPortfolioCode) ekliyoruz
    const url = `${BASE_URL}/infleks-inx-api/api/v1/hedefyatirim/basic/py/list/securitiesStock?portfolioRefCode=${realPortfolioCode}`;
    
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
            csvCodeFound: originalCsvCode, // Logda senin nt920'ni göreceksin
            realCodeSent: realPortfolioCode, // Ama sisteme giden yy2920 vb. olacak
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