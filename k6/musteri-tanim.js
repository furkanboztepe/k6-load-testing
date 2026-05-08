import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Rate, Trend, Counter } from 'k6/metrics';

const errorRate = new Rate('vu_errors');
const responseTime = new Trend('vu_duration');
const errorCounter = new Counter('vu_error_count');

const SCENARIO_NAME = 'musteri-tanim';

// --- YENİ CSV VERİSİ OKUMA ---
const csvData = new SharedArray('musteri', function () {
    return open('./Musteri_tanim_yeni_37.csv')
        .replace(/\r/g, '') // Satır sonu karakterlerini temizle
        .split('\n')
        // Başlık satırı (Header) olmadığı için .slice(1) kodu KALDIRILDI
        .filter(l => l.trim().length > 0)
        .map(line => line.split(';'));
});

export const options = {
    scenarios: {
        [SCENARIO_NAME]: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '50s', target: 1000 }
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
    // VU ve Iteration ile satırları daha dengeli dağıtıyoruz
    const rowIndex = (__VU + __ITER) % csvData.length;
    const row = csvData[rowIndex];
    
    // Güvenlik kalkanları: Trim ile boşlukları uçuruyoruz
    const pCustomerTitle = row[0].trim();
    const pRefCode = row[1].trim();
    const pTurkishIdNo = row[2].trim();

    const vuTag = { vu: String(__VU), iteration: String(__ITER) };

    const payload = JSON.stringify({
        contacts: [
            { contactType: "POSTADDRESS", contactLoc: "HOME", contactText: "ggggg", postalCode: "34000", city: "TR-36", country: "TR", useForReports: "1" },
            { contactType: "TELEPHONE", contactLoc: "MOBILE", contactText: "5551586132" },
            { contactType: "EMAIL", contactLoc: "HOME", contactText: "gulay3@hmail.com", useForReports: "1" }
        ],
        suitabilityTests: [ { suiTestName: null, suiTestDate: null, suiTestScore: null } ],
        customerType: "INDIVIDUAL",
        customerTitle: pCustomerTitle,
        customerNote: "müşteri not",
        entryDate: "2026-01-12",
        refCode: pRefCode,
        fundFounder: 0,
        branchCode: "10",
        bankBranchStockCode: "FKT",
        segmentNo: 1,
        residenceCertificate: 1,
        birthCity: "Hayrabolu",
        dividendRateType: "NET",
        gdprPerm: true,
        citizenshipCountry: "TR",
        individual: {
            middleName: "eness", firstName: "ERCHİRİON", motherName: "ERDİN", fatherName: "YAPRAK SOĞANI",
            birthDate: "1996-01-10", birthCity: "06", gender: "MALE", citizenshipRegCity: "06", citizenshipRegCode: "TR",
            TurkishIdNo: pTurkishIdNo, residencePlace: "1", employer: "İnfina Yazılım A.Ş."
        },
        tax: { taxpayerType: "FULL" },
        additionalInfo: { mbbNo: 1 }
    });

    // Zırhlı Header (401 hatalarını engellemek için VEYA kapıları eklendi)
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
    const res = http.post(`${BASE_URL}/infleks-inx-api/api/v1/hedefyatirim/basic/my/definition/customer`, payload, params);
    const duration = new Date().getTime() - start;

    const success = check(res, {
        'status 200': (r) => r.status === 200,
        'response time < 20s': (r) => r.timings.duration < 20000,
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
            customerTitle: pCustomerTitle,
            refCode: pRefCode,
            TurkishIdNo: pTurkishIdNo,
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