import http from 'k6/http';
import { check } from 'k6'; 
import { SharedArray } from 'k6/data';
import { Rate, Trend, Counter } from 'k6/metrics';
import { scenario } from 'k6/execution'; 

// --- Custom Metrikler ---
const errorRate = new Rate('vu_errors');
const responseTime = new Trend('vu_duration');
const errorCounter = new Counter('vu_error_count');

const SCENARIO_NAME = 'fonhesap-islem';

// 1. Yeni CSV Verisini Oku (Fon Hesap İşlem)
const csvData = new SharedArray('fonhesap', function () {
    return open('./fonhesap_islem.csv')
        .replace(/\r/g, '') 
        .split('\n')
        .slice(1) 
        .filter(l => l.trim().length > 0)
        .map(line => line.split(';'));
});

// 2. 400 Hatasını Engellemek İçin Gerçek Portföy Kodlarını Oku
const portfolioCsv = new SharedArray('portfoy_match', function () {
    return open('./portfolio.csv') 
        .replace(/\r/g, '') 
        .split('\n')
        .slice(1) 
        .filter(l => l.trim().length > 0)
        .map(line => line.split(';'));
});

// --- JMETER İLE BİREBİR AYNI YÜK TESTİ AYARLARI ---
export const options = {
    scenarios: {
        [SCENARIO_NAME]: {
            executor: 'constant-arrival-rate',
            // 1000 Kullanıcı / 100 Saniye Ramp-up = Saniyede 10 İstek
            rate: 10, 
            timeUnit: '1s',
            duration: '100s',
            
            preAllocatedVUs: 50, 
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
    const rowIndex = scenario.iterationInTest % csvData.length;
    
    const row = csvData[rowIndex];
    const portfoyRow = portfolioCsv[rowIndex]; 

    // CSV'deki `nt1` yerine, sistemde gerçekten var olan `yy2001` değerini (3. sütun) alıyoruz
    const pPortfolioRefCode = portfoyRow[2]; 
    
    // Fonhesap CSV Sıralaması: cashTranNo;amount;portfolioRefCode
    const pCashTranNo = row[0];
    const pAmount = row[1]; // JMeter'da 100 yazıyordu ama CSV'deki tutarı göndermek daha dinamiktir

    const vuTag = { vu: String(__VU), iteration: String(__ITER) };

    // JMeter'daki Payload yapısının BİREBİR aynısı
    const payload = JSON.stringify({
        cashTranNo: pCashTranNo,
        cashTranDate: "2025-11-14",
        cashTranType: 101,
        currencyCode: "TL",
        mainAccount: null,
        subAccount: null,
        amount: String(pAmount) || "100", 
        description: null,
        counterAccount: 1,
        parity: 1,
        cashAccountFeature: 1,
        cashAccountCurrencyType: "TL",
        portfolioRefCode: pPortfolioRefCode 
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
    
    // JMeter URL Adresi
    const url = `${BASE_URL}/infleks-inx-api/api/v1/hedefyatirim/basic/py/transaction/cashTransactions`;
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
            cashTranNo: pCashTranNo,
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