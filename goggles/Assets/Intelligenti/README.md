# Intelligenti Goggles

Beam Pro上で動作し、XREALゴーグルへ商品情報を表示するUnityアプリです。

## 現在の機能

- MQTT `intelligenti/readers/+/scan` を購読
- NFCリーダーから届いた商品IDを取得
- `GET /api/products/{productId}` で商品情報を取得
- 商品名、価格、在庫、棚番号、説明をHUD表示
- Android BLEでIntelligenti NFC Readerを検索・接続
- BLEでタグ書込モード開始・停止
- XREAL Eyeの接続、RGBフレーム、カメラ内部パラメータを診断
- EyeのRGB映像から棚QRマーカーを認識
- マーカーIDをAPIで棚へ解決し、実空間の棚位置へ枠と棚名を表示
- NFCで商品を選択した後に現在地QRを読むと、店舗マップの経路を取得
- QRの実空間姿勢と店舗マップの向きを合わせ、6DoFで進行方向と残り距離を更新
- 案内対象商品のマーカーが一致した場合、棚内オフセット位置を強調表示
- Eyeの6DoFへ切り替え、視界前方へ空間固定テスト枠を表示
- Editor用の疑似操作パネル

シーンへコンポーネントを手作業で置かなくても、起動時に`Intelligenti Runtime`が自動生成されます。

## 設定

`Assets/Intelligenti/Resources/intelligenti-config.json`を環境に合わせて変更します。

```json
{
  "apiBaseUrl": "https://nfc-api.tkgon.net",
  "mqttHost": "",
  "mqttPort": 1883,
  "mqttUsername": "",
  "mqttPassword": "",
  "goggleApiKey": "Beam Pro専用の経路APIキー",
  "scanTopic": "intelligenti/readers/+/scan"
}
```

`goggleApiKey`にはサーバーの`GOGGLE_API_KEY`と同じ値を設定します。
管理者用の`ADMIN_API_KEY`はAPKへ入れないでください。この端末キーで利用できるのは
`POST /api/navigation/route`だけです。

Development BuildではAndroid起動時のIntent extraでもAPI URLを上書きできます。

```text
intelligenti.apiBaseUrl=http://192.168.11.6:3100
intelligenti.goggleApiKey=<GOGGLE_API_KEY>
```

端末キーのIntent extraはBeam Pro内へ保存され、次回起動後も使用されます。
ログにはキー本体を出力しません。

## 商品APIのレスポンス

```json
{
  "id": "PRD-00000001",
  "name": "サンプル商品",
  "description": "商品の説明",
  "price": "¥298",
  "stock": 12,
  "shelfId": "A-03",
  "shelfName": "飲料棚 A-03",
  "zone": "飲料",
  "markerId": "MARKER-A03",
  "shelfOffset": { "x": 0.2, "y": 0.1, "z": 0.0 },
  "imageUrl": ""
}
```

## 棚マーカー

管理サイトで棚とマーカーIDを紐付けて印刷します。Eyeは`INTELLIGENTI:`で始まるQRだけを対象とし、既知の印刷サイズ160 mmとカメラ内部パラメータから位置・距離を推定します。マーカーは折れや反射を避け、棚の正面へ平らに貼ってください。

店舗マップ上のQRの矢印は、実際に印刷したQRの正面方向と合わせます。商品選択後にQRを読むと、APIが返す地図経路をその向きへ固定し、HUDに次の進行方向・残り距離・目的棚を表示します。案内中はXREALの6DoF位置を使って次の通路点を更新し、別の現在地QRを読むとその地点から経路を再計算します。

## XREAL SDK

公式XREAL SDK 3.1.0を`Packages/com.xreal.xr`へ埋め込んでいます。テンプレートに含まれていた開発元の絶対パス参照は除去済みです。

XREAL 1S + Eyeでは、起動後にHUDへ次の診断値を表示します。

- 接続したXREALデバイス種別
- 現在のトラッキングモード
- 位置トラッキング対応状態
- RGBカメラの解像度と実測フレームレート
- マーカー姿勢推定に必要な焦点距離・主点

シアン色の四隅枠はカメラの子ではなくUnityワールドへ配置されます。頭を左右に動かしたときに枠が実空間の同じ場所へ残れば、6DoF位置トラッキングが動作しています。Development Buildでは疑似操作パネルから6DoF切替、枠の再配置、RGB取得の再試行ができます。
