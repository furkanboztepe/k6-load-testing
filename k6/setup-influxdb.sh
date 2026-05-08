#!/bin/bash
# InfluxDB 2.x'te k6 için 1.x compat token ve DBRP mapping oluşturur
# docker-compose up sonrası bir kez çalıştırın

set -e

INFLUX_URL="http://localhost:8086"
ORG="infina"
BUCKET="k6"
USERNAME="admin"
PASSWORD="admin123"

echo "⏳ InfluxDB hazır olana kadar bekleniyor..."
until curl -sf "$INFLUX_URL/ping" > /dev/null 2>&1; do
    sleep 2
done
echo "✅ InfluxDB hazır"

# Admin token al
echo "🔑 Admin token alınıyor..."
ADMIN_TOKEN=$(curl -sf -X POST "$INFLUX_URL/api/v2/signin" \
    -u "$USERNAME:$PASSWORD" \
    -H "Content-Type: application/json" | \
    docker exec -i influxdb influx auth list --json 2>/dev/null | \
    python3 -c "import sys,json; auths=json.load(sys.stdin); print(auths[0]['token'])" 2>/dev/null || echo "")

# Eğer token alınamadıysa setup token'ını dene
if [ -z "$ADMIN_TOKEN" ]; then
    ADMIN_TOKEN=$(docker exec influxdb cat /etc/influxdb2/influx-configs 2>/dev/null | grep "token" | awk -F'"' '{print $2}' || echo "admin123token")
fi

echo "📦 Bucket ID alınıyor..."
BUCKET_ID=$(curl -sf \
    -H "Authorization: Token $ADMIN_TOKEN" \
    "$INFLUX_URL/api/v2/buckets?name=$BUCKET&org=$ORG" | \
    python3 -c "import sys,json; data=json.load(sys.stdin); print(data['buckets'][0]['id'])")

echo "Bucket ID: $BUCKET_ID"

# 1.x compat için DBRP mapping oluştur
echo "🔗 DBRP mapping oluşturuluyor (InfluxDB 1.x compat)..."
curl -sf -X POST \
    -H "Authorization: Token $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    "$INFLUX_URL/api/v2/dbrps?org=$ORG" \
    -d "{
        \"bucketID\": \"$BUCKET_ID\",
        \"database\": \"k6\",
        \"default\": true,
        \"org\": \"$ORG\",
        \"retention_policy\": \"autogen\"
    }" && echo "✅ DBRP mapping oluşturuldu" || echo "⚠️  DBRP mapping zaten var"

# k6 için ayrı token oluştur (okuma/yazma)
echo "🔑 k6 için write token oluşturuluyor..."
K6_TOKEN=$(curl -sf -X POST \
    -H "Authorization: Token $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    "$INFLUX_URL/api/v2/authorizations" \
    -d "{
        \"orgID\": \"$(curl -sf -H "Authorization: Token $ADMIN_TOKEN" $INFLUX_URL/api/v2/orgs | python3 -c "import sys,json; print(json.load(sys.stdin)['orgs'][0]['id'])")\",
        \"description\": \"k6 load test token\",
        \"permissions\": [
            {\"action\": \"write\", \"resource\": {\"type\": \"buckets\", \"id\": \"$BUCKET_ID\"}},
            {\"action\": \"read\",  \"resource\": {\"type\": \"buckets\", \"id\": \"$BUCKET_ID\"}}
        ]
    }" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Kurulum tamamlandı!"
echo ""
echo "Admin Token : $ADMIN_TOKEN"
echo "k6 Token    : $K6_TOKEN"
echo ""
echo "k6 çalıştırma komutu:"
echo "  k6 run --out influxdb=http://localhost:8086/k6 musteri-tanim.js"
echo ""
echo "Grafana → http://localhost:3000 (admin/admin123)"
echo "InfluxDB → http://localhost:8086 (admin/admin123)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"