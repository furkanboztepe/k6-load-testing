import http from 'k6/http';
import { check } from 'k6'; 
import { SharedArray } from 'k6/data';
import { Rate, Trend, Counter } from 'k6/metrics';
import { scenario } from 'k6/execution'; // Sıralı okuma için execution motorunu ekledik

const errorRate = new Rate('vu_errors');
const responseTime = new Trend('vu_duration');
const errorCounter = new Counter('vu_error_count');

const SCENARIO_NAME = 'nakithesap-tanim';

// 1. Orijinal Nakit Hesap CSV'sini oku (Dosyaya dokunmuyoruz)
const csvData = new SharedArray('nakithesap', function () {
    return open('./nakithesap.csv') // Eğer dosya adınız farklıysa burayı güncelleyin (Örn: NAKITHESAPTANIMM.csv)
        .replace(/\r/g, '') 
        .split('\n')
        .slice(1) 
        .filter(l => l.trim().length > 0)
        .map(line => line.split(';'));
});

// 2. Portföy CSV'sini de arka planda oku (Gerçek kodları çalmak için)
const portfolioCsv = new SharedArray('portfoy_match', function () {
    return open('./portfolio.csv') // Eğer dosya adınız farklıysa burayı güncelleyin (Örn: PORTFOYTANIMM.csv)
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
            rate: 4, 
            timeUnit: '1s',
            duration: '250s',
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
    // K6'nın her satırı sırayla okuması için global index alıyoruz
    const rowIndex = scenario.iterationInTest % csvData.length;
    
    // Her iki dosyadan da aynı sıradaki satırı çekiyoruz
    const row = csvData[rowIndex];
    const portfoyRow = portfolioCsv[rowIndex]; 

    // SİHİRLİ DOKUNUŞ: Kendi dosyasındaki nt1'i (row[0]) iptal et, Portföy dosyasındaki 3. sütunu (portfoyRow[2]) kullan!
    const pPortfolioRefCode = portfoyRow[2]; 
    
    const pCurrencyCode = row[1];
    const pAccountNo = row[2];
    const pCashAccountName = row[3];
    const pRefCode = row[4];
    const pIban = row[5];

    const vuTag = { vu: String(__VU), iteration: String(__ITER) };

    const payload = JSON.stringify({
        accountNo: pAccountNo,
        cashAccountName: pCashAccountName,
        refCode: pRefCode,
        iban: pIban
    });

    const params = {
        headers: { 
            'X-Api-Key': __ENV.API_KEY, 
            'pmcCode': __ENV.PMC_CODE,
            'token': __ENV.API_TOKEN,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        timeout: '60s',
        tags: vuTag
    };

    const start = new Date().getTime();
    
    // Artık URL'ye dinamik olarak gerçek portföy kodları (yy2001, yy2002 vb.) yerleşecek
    const url = `${BASE_URL}/infleks-inx-api/api/v1/hedefyatirim/basic/py/definition/cashAccounts/portfolio/${pPortfolioRefCode}/currency/${pCurrencyCode}`;
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
            portfolioRefCode: pPortfolioRefCode, // Loga düşerse gerçek kodu göreceksiniz
            iban: pIban,
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