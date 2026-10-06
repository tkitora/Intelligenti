# Intelligenti Server

## 店舗マップ

管理画面の「店舗マップ」は、1店舗・1フロア専用の見下ろしマップです。
座標や経路ノードを直接入力せず、棚と現在地QRをドラッグ配置し、歩ける通路をドラッグして描きます。

- 棚: 既存の売場データを選んで配置、サイズ・向き・商品を取る側を設定
- 現在地QR: 表示名・QR ID・向きを設定して印刷
- 通路: 始点から終点までドラッグ。交差した通路は経路探索時に自動接続
- 案内テスト: 開始QRと商品を選択し、実際の最短経路をプレビュー
- 保存: マップ全体をDBの単一レコードへ保存（この導入店舗専用）

主なAPI:

- `GET /api/store-map`
- `PUT /api/store-map`
- `POST /api/navigation/route`

店舗マップの取得・保存には管理セッションまたは管理者Bearer APIキーが必要です。
経路計算はそれらに加えて、権限を経路計算だけに限定したBeam Pro用Bearerキーでも利用できます。

Intelligentiの商品DB、REST API、MQTT BrokerをまとめたDocker構成です。

## ポート

- API: `3100`
- MQTT: `1884`
- MQTT WebSocket: `9002`

既存試作の`3000`、`1883`、`9001`と競合しない構成です。各ポートは`.env`の`BIND_HOST`で指定したLAN IPにだけバインドします。

## 管理画面

- URL: `http://192.168.11.7:3100/admin/`
- 商品の登録・編集・削除
- 売場・棚の登録・編集
- 棚とEye用QRマーカーの紐付け、プレビュー、印刷
- Web BluetoothでNFCリーダーへ接続し、商品IDをタグへ書込み
- `BEAMPRO-01`への商品案内送信

ログインには`.env`の`ADMIN_UI_PASSWORD`を使用します。認証後はHttpOnlyセッションCookieを使うため、管理APIキーをブラウザへ保存しません。

NFCタグ書込みはHTTPSで配信された管理画面をChromeまたはEdgeで開いて使用します。商品IDはタグ形式に合わせて13文字以内です。

## API

- `GET /health`
- `GET /api/products?q=緑茶`
- `GET /api/products/:id`
- `POST /api/products`（管理者）
- `PUT /api/products/:id`（管理者）
- `DELETE /api/products/:id`（管理者）
- `GET /api/shelves`
- `POST /api/shelves`（管理者）
- `PUT /api/shelves/:id`（管理者）
- `GET /api/markers/:markerId`
- `GET /api/markers/:markerId/image.svg`
- `GET /api/scan-events`（管理者）
- `POST /api/goggles/:goggleId/target`（管理者）
- `POST /api/navigation/route`（管理者またはBeam Pro）

管理者APIは`Authorization: Bearer <ADMIN_API_KEY>`が必要です。
Beam Proには管理者キーを入れず、必ず別の`GOGGLE_API_KEY`を設定してください。
このキーで利用できるのは経路計算だけで、店舗マップや商品を変更する権限はありません。

### Beam Proからの経路計算

現在地QRとNFCで選択済みの商品IDを送ります。

```http
POST /api/navigation/route
Authorization: Bearer <GOGGLE_API_KEY>
Content-Type: application/json

{
  "fromMarkerId": "MARKER-A01",
  "toProductId": "PRD-00000001"
}
```

商品ではなく棚へ直接案内する場合は、`toProductId`の代わりに`toShelfId`を指定できます。
成功レスポンスの座標値と距離はすべてメートルです。原点はマップ左上、X軸は右、Y軸は下、QRの回転角はマップ上方向を0度とする時計回りです。現在地QRの矢印は、QR面の法線ではなく「利用者がそのQRを読み取るときに向く方向」を表します。

```json
{
  "schemaVersion": 1,
  "mapVersion": 7,
  "coordinateSystem": "x-right-y-down-meters-rotation-clockwise-from-north",
  "fromMarkerId": "MARKER-A01",
  "toProductId": "PRD-00000001",
  "toShelfId": "SHELF-A01",
  "distanceMeters": 8.4,
  "startMarker": {
    "markerId": "MARKER-A01",
    "label": "入口",
    "position": { "x": 1.2, "y": 2.5 },
    "rotationDegrees": 90
  },
  "destination": { "x": 8.1, "y": 5.4 },
  "points": [
    { "x": 1.2, "y": 2.5 },
    { "x": 2.0, "y": 2.5 },
    { "x": 8.1, "y": 5.4 }
  ]
}
```

`schemaVersion`はレスポンス形式、`mapVersion`は管理画面で保存されたマップの版数です。
既存の管理画面による案内プレビューは、同じAPIを管理セッションで呼び出します。

### 動作確認

`GOGGLE_API_KEY`を渡したスモークテストは、Beam Proキーで経路APIへ到達できることと、そのキーでは管理用店舗マップを取得できないことを確認します。実際の経路レスポンス形式まで検査する場合は、保存済みマップ上で接続されているQRと商品または棚も指定します。

```bash
API_URL=http://127.0.0.1:3100 \
ADMIN_API_KEY=... \
GOGGLE_API_KEY=... \
SMOKE_ROUTE_MARKER_ID=MARKER-A01 \
SMOKE_ROUTE_PRODUCT_ID=PRD-00000001 \
npm run smoke
```

マーカー画像は`INTELLIGENTI:<markerId>`を格納したQRコードです。管理画面の「マーカーを印刷」から、実寸160 mmを基準にした印刷ページを開けます。棚ごとに異なるマーカーIDを割り当ててください。

## MQTT

- NFC読取: `intelligenti/readers/{readerId}/scan`
- リーダー状態: `intelligenti/readers/{readerId}/status`
- ゴーグル検索対象: `intelligenti/goggles/{goggleId}/target`

匿名接続は無効です。
