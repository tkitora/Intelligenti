# Intelligenti

スーパー内の商品検索・棚案内を、NFCリーダー、Beam Pro、XREAL Eye、管理サイトで連携させる試作プロジェクトです。

- `src/`: XIAO ESP32-S3 + PN532のNFCリーダーファームウェア
- `server/`: 商品・棚・マーカー管理サイト、REST API、MQTT
- `goggles/`: XREAL Eyeで棚マーカーを認識しAR表示するUnityアプリ

## NFC Reader

スーパーの商品タグを読み書きする携帯デバイス用PlatformIOプロジェクトです。

## 対象ハードウェア

- Seeed Studio XIAO ESP32-S3
- PN532 NFCリーダー／ライター（I²Cモード）
- MIFARE Classic 1Kタグ
- 3.3V対応のコモンカソードRGB LED
- 必要に応じて3.7V保護回路付きLiPoバッテリー

## 配線

| PN532 | XIAO ESP32-S3 |
|---|---|
| SDA | D4 |
| SCL | D5 |
| VCC | 3V3 |
| GND | GND |

PN532基板の通信モードスイッチまたはジャンパーをI²Cに設定してください。IRQとRSTは接続しません。ピン名や設定方法は製品ごとに違うため、実物の説明書を優先してください。

RGB LEDは以下です。

| LED | XIAO ESP32-S3 |
|---|---|
| 赤 | D0（抵抗を直列） |
| 緑 | D1（抵抗を直列） |
| 青 | D2（抵抗を直列） |
| 共通カソード | GND |

## LED状態

- 緑: 通常読取モード
- 青: タグ書込待機
- 黄: Wi-Fi接続中
- 水色: タグ読取成功
- 赤: エラー

## BLE

デバイス名は `Intelligenti-XXXXXX` です。

- Service: `9d880100-504a-4c45-4e54-454c4c494745`
- Command（Write）: `9d880101-504a-4c45-4e54-454c4c494745`
- Status（Read/Notify）: `9d880102-504a-4c45-4e54-454c4c494745`

CommandへUTF-8 JSONを送ります。

### ネットワーク設定

```json
{
  "cmd": "configure",
  "ssid": "STORE_WIFI",
  "wifiPassword": "password",
  "mqttHost": "192.168.1.10",
  "mqttPort": 1883,
  "mqttUsername": "reader",
  "mqttPassword": "password"
}
```

公開APIへHTTPS送信する現在の推奨設定は次の形式です。管理画面の
「接続設定」が認証キーをサーバーから取得し、このJSONを自動送信します。

```json
{
  "cmd": "configure",
  "ssid": "tkgon iPhone",
  "wifiPassword": "password",
  "apiBaseUrl": "https://nfc-api.tkgon.net",
  "apiKey": "reader-scoped-secret"
}
```

### タグ書込開始

```json
{"cmd":"write","productId":"PRD-00001234"}
```

商品IDは英数字、`-`、`_`のみで最大13文字です。

### 書込停止

```json
{"cmd":"stop"}
```

### 状態取得

```json
{"cmd":"status"}
```

## 専用リセットNFC

UID `37D33463` の物理タグを専用リセットNFCとしてファームウェアへ固定しています。
このタグを読むと `BEAMPRO-01` の選択商品と経路表示を解除し、待機状態へ
戻します。通常の商品タグを書き込んでも、このUIDのタグは常にリセットとして
扱われます。

## MQTT

各デバイスは下記へ送信します。

```text
intelligenti/readers/{deviceId}/scan
intelligenti/readers/{deviceId}/status
```

scan payload:

```json
{
  "deviceId": "A1B2C3",
  "productId": "PRD-00001234",
  "tagUid": "04AABBCC",
  "rssi": -52,
  "uptimeMs": 123456
}
```

## タグデータ形式

MIFARE Classic 1Kのブロック4へ16バイトを書き込みます。

```text
byte 0: 0x49 ('I')
byte 1: 0x4E ('N')
byte 2: 商品ID長
byte 3-15: 商品ID
```

初期鍵 `FF FF FF FF FF FF` を使います。商品情報や価格はタグへ保存せず、DB検索用の商品IDだけを保存します。

## ビルド

```bash
pio run
```

書き込み:

```bash
pio run --target upload
```

シリアルモニター:

```bash
pio device monitor
```

## 次段階: 店内レイアウト管理

実運用で提供する中心機能は次の2つです。

1. NFCで選択した商品の在庫数、登録画像、陳列場所をAR表示する
2. 店内の二次元コードを現在地として読み取り、選択商品の陳列場所まで案内する

管理サイトには、商品と棚の登録に加えて「どの陳列場所が店内のどこに並んでいるか」を作成・保存する棚配置エディタが必要です。次段階では、売場平面図、棚の配置・向き、通路、二次元コードの現在地、棚間の移動経路を一体として管理できる構成を検討します。

## XREAL SDK について

`goggles/` の Unity プロジェクトが依存する XREAL SDK (`com.xreal.xr`) は、再配布を避けるためこのリポジトリに含めていません。
`goggles/Packages/manifest.json` は `file:com.xreal.xr` を参照しているため、XREAL 公式から SDK を入手し、`goggles/Packages/com.xreal.xr/` に配置してからプロジェクトを開いてください。
