#!/usr/bin/env bash
# Generate a self-signed cert valid for this Mac's LAN IP.
# iOS requires a SAN (CN alone is ignored), SHA-256, and <=825 days validity.
set -euo pipefail
cd "$(dirname "$0")"

IP="${1:-127.0.0.1}"
OPENSSL="$(command -v openssl)"

cat > .san.cnf <<CNF
[req]
distinguished_name = dn
x509_extensions    = v3
prompt             = no
[dn]
CN = imu-flight-rig
[v3]
subjectAltName       = IP:${IP}, IP:127.0.0.1, DNS:localhost
basicConstraints     = critical, CA:FALSE
keyUsage             = critical, digitalSignature, keyEncipherment
extendedKeyUsage     = serverAuth
CNF

"$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days 397 -nodes \
  -keyout key.pem -out cert.pem -config .san.cnf >/dev/null 2>&1

rm -f .san.cnf
echo "$IP" > .cert_ip
chmod 600 key.pem
echo "generated cert for ${IP}"
