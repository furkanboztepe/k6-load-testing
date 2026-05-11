import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Rate, Trend, Counter } from 'k6/metrics';

// =====================================================================
//  ÇOKLU SUNUCU YÜK TESTİ - MÜŞTERİ TANIMLAMA
//  - bs-testha-1 ve bs-testha-2 sunucularına EŞZAMANLI yük
//  - Her senaryo: 4000 VU, 150sn ramp-up
//  - Metrikler "server" tag'i ile InfluxDB'ye yazılır
// =====================================================================

const errorRate = new Rate('vu_errors');
const responseTime = new Trend('vu_duration');
const errorCounter = new Counter('vu_error_count');

const SCENARIO_BASE = 'musteri-tanim';

const csvData = new SharedArray('musteri', function () {
    return open('./Musteri_tanim_yeni_37.csv')
        .replace(/\r/g, '')
        .split('\n')
        .filter(l => l.trim().length > 0)
        .map(line => line.split(';'));
});

export const options = {
    scenarios: {
        server1: {
            executor: 'ramping-vus',
            exec: 'server1Test',
            startVUs: 0,
            stages: [
                { duration: '10s', target: 10 }
            ],
            gracefulRampDown: '0s',
            tags: {
                testName: SCENARIO_BASE,
                server: 'bs-testha-1',
                environment: 'test',
            },
        },
        server2: {
            executor: 'ramping-vus',
            exec: 'server2Test',
            startVUs: 0,
            stages: [
                { duration: '10s', target: 10 }
            ],
            gracefulRampDown: '0s',
            tags: {
                testName: SCENARIO_BASE,
                server: 'bs-testha-2',
                environment: 'test',
            },
        },
    },
    thresholds: {
        vu_errors: ['rate<0.05'],
        vu_duration: ['p(95)<20000'],
        http_req_duration: ['p(95)<20000'],
        'http_req_duration{server:bs-testha-1}': ['p(95)<20000'],
        'http_req_duration{server:bs-testha-2}': ['p(95)<20000'],
        'vu_errors{server:bs-testha-1}': ['rate<0.05'],
        'vu_errors{server:bs-testha-2}': ['rate<0.05'],
    },
};

const BASE_URL_1 = __ENV.HEDEF_YATIRIM_BASE_URL;
const BASE_URL_2 = __ENV.HEDEF_YATIRIM_BASE_URL_2;

function getIstanbulTime() {
    const d = new Date();
    const ist = new Date(d.getTime() + (3 * 60 * 60 * 1000));
    return ist.toISOString().replace('Z', '+03:00');
}

function runRequest(baseUrl, serverLabel, half) {
    // CSV'yi ikiye bölüyoruz: half=0 -> ilk yarı, half=1 -> ikinci yarı
    const halfLen = Math.floor(csvData.length / 2);
    const baseIndex = half === 0 ? 0 : halfLen;
    const range = half === 0 ? halfLen : (csvData.length - halfLen);
    const rowIndex = baseIndex + ((__VU + __ITER) % range);

    const row = csvData[rowIndex];
    const pCustomerTitle = row[0].trim();
    const pRefCode = row[1].trim();
    const pTurkishIdNo = row[2].trim();

    const vuTag = {
        vu: String(__VU),
        iteration: String(__ITER),
        server: serverLabel,
    };

    const payload = JSON.stringify({
        contacts: [
            { contactType: "POSTADDRESS", contactLoc: "HOME", contactText: "ggggg", postalCode: "34000", city: "TR-36", country: "TR", useForReports: "1" },
            { contactType: "TELEPHONE", contactLoc: "MOBILE", contactText: "5551586132" },
            { contactType: "EMAIL", contactLoc: "HOME", contactText: "gulay3@hmail.com", useForReports: "1" }
        ],
        suitabilityTests: [{ suiTestName: null, suiTestDate: null, suiTestScore: null }],
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

    const params = {
        headers: {
            'X-Api-Key': __ENV.API_KEY || '1234',
            'Content-Type': 'application/json',
            'pmcCode': __ENV.PMC_CODE || 'ENE',
            'token': __ENV.API_TOKEN || 'ERYTESTENESTEST'
        },
        timeout: '60s',
        tags: vuTag,
    };

    const start = new Date().getTime();
    const res = http.post(
        `${baseUrl}/infleks-inx-api/api/v1/hedefyatirim/basic/my/definition/customer`,
        payload,
        params
    );
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
            testName: SCENARIO_BASE,
            server: serverLabel,
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

export function server1Test() {
    runRequest(BASE_URL_1, 'bs-testha-1', 0);
}

export function server2Test() {
    runRequest(BASE_URL_2, 'bs-testha-2', 1);
}

export function handleSummary(data) {
    const summary = {
        testName: SCENARIO_BASE,
        completedAt: getIstanbulTime(),
        servers: ['bs-testha-1', 'bs-testha-2'],
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
        [`./k6-logs/summary-${SCENARIO_BASE}-multiserver.json`]: JSON.stringify(summary, null, 2),
    };
}