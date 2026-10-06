#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
umask 077

if [ ! -f .env ]; then
  db_password="$(openssl rand -hex 24)"
  root_password="$(openssl rand -hex 24)"
  admin_key="$(openssl rand -hex 32)"
  admin_ui_password="IT-$(openssl rand -hex 6)"
  goggle_key="$(openssl rand -hex 32)"
  reader_key="$(openssl rand -hex 32)"
  mqtt_password="$(openssl rand -hex 24)"

  printf '%s\n' \
    'BIND_HOST=192.168.11.7' \
    'API_PORT=3100' \
    'MQTT_PORT=1884' \
    'MQTT_WEBSOCKET_PORT=9002' \
    'DB_NAME=intelligenti' \
    'DB_USER=intelligenti' \
    "DB_PASSWORD=$db_password" \
    "DB_ROOT_PASSWORD=$root_password" \
    "ADMIN_API_KEY=$admin_key" \
    "ADMIN_UI_PASSWORD=$admin_ui_password" \
    "GOGGLE_API_KEY=$goggle_key" \
    "READER_API_KEY=$reader_key" \
    'PUBLIC_API_BASE_URL=https://nfc-api.tkgon.net' \
    'MQTT_USERNAME=intelligenti' \
    "MQTT_PASSWORD=$mqtt_password" > .env
fi

if ! grep -q '^READER_API_KEY=' .env; then
  printf 'READER_API_KEY=%s\n' "$(openssl rand -hex 32)" >> .env
fi

if ! grep -q '^PUBLIC_API_BASE_URL=' .env; then
  printf 'PUBLIC_API_BASE_URL=https://nfc-api.tkgon.net\n' >> .env
fi

if ! grep -q '^ADMIN_UI_PASSWORD=' .env; then
  printf 'ADMIN_UI_PASSWORD=IT-%s\n' "$(openssl rand -hex 6)" >> .env
fi

# Existing installations predate the Beam Pro route credential. Add it without
# rotating or otherwise disturbing any deployed administrator secrets.
if ! grep -q '^GOGGLE_API_KEY=' .env; then
  printf 'GOGGLE_API_KEY=%s\n' "$(openssl rand -hex 32)" >> .env
fi

set -a
. ./.env
set +a

if [ ! -f mosquitto/passwords ]; then
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$(pwd)/mosquitto:/mosquitto/config" \
    eclipse-mosquitto:2 \
    mosquitto_passwd -b -c /mosquitto/config/passwords \
    "$MQTT_USERNAME" "$MQTT_PASSWORD"
fi

mkdir -p runtime
printf '%s\n' \
  '{' \
  '  "apiBaseUrl": "http://192.168.11.7:3100",' \
  '  "mqttHost": "192.168.11.7",' \
  '  "mqttPort": 1884,' \
  "  \"mqttUsername\": \"$MQTT_USERNAME\"," \
  "  \"mqttPassword\": \"$MQTT_PASSWORD\"," \
  '  "scanTopic": "intelligenti/readers/+/scan",' \
  '  "goggleId": "BEAMPRO-01",' \
  "  \"goggleApiKey\": \"$GOGGLE_API_KEY\"," \
  '  "targetTopic": "intelligenti/goggles/BEAMPRO-01/target"' \
  '}' > runtime/intelligenti-config.json

chmod 600 .env runtime/intelligenti-config.json
# The container runs as its own unprivileged user and needs to read this
# bind-mounted file. It contains a salted hash, not the plaintext password.
chmod 644 mosquitto/passwords
echo 'Intelligenti server secrets and runtime configuration are ready.'
