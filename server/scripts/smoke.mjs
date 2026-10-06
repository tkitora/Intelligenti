import mqtt from "mqtt";

const api = process.env.API_URL ?? "http://127.0.0.1:3100";
const mqttUrl = process.env.MQTT_URL ?? "mqtt://127.0.0.1:1884";

const bearerHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

async function responseJson(response) {
  const body = await response.json().catch(() => null);
  return body;
}

function validateRouteResponse(route) {
  if (route?.schemaVersion !== 1 || !Number.isInteger(route.mapVersion))
    throw new Error("Navigation route version metadata is invalid");
  if (route.coordinateSystem !== "x-right-y-down-meters-rotation-clockwise-from-north")
    throw new Error("Navigation coordinate system is invalid");
  if (!route.startMarker || !Number.isFinite(route.startMarker.position?.x) ||
      !Number.isFinite(route.startMarker.position?.y) ||
      !Number.isFinite(route.startMarker.rotationDegrees))
    throw new Error("Navigation start marker is invalid");
  if (!Number.isFinite(route.destination?.x) || !Number.isFinite(route.destination?.y) ||
      !Array.isArray(route.points) || route.points.length < 2 ||
      route.points.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y)))
    throw new Error("Navigation route geometry is invalid");
}

const health = await fetch(`${api}/health`);
if (!health.ok) throw new Error(`Health failed: ${health.status}`);
console.log("health", await health.json());

const product = await fetch(`${api}/api/products/PRD-00000001`);
if (!product.ok) throw new Error(`Product failed: ${product.status}`);
console.log("product", await product.json());

if (process.env.ADMIN_API_KEY) {
  const map = await fetch(`${api}/api/store-map`, {
    headers: bearerHeaders(process.env.ADMIN_API_KEY),
  });
  if (!map.ok) throw new Error(`Store map failed: ${map.status}`);
  const mapBody = await map.json();
  if (!mapBody.layout || !Array.isArray(mapBody.layout.shelves) ||
      !Array.isArray(mapBody.layout.markers) || !Array.isArray(mapBody.layout.paths))
    throw new Error("Store map response is invalid");
  console.log("store map", {
    shelves: mapBody.layout.shelves.length,
    markers: mapBody.layout.markers.length,
    paths: mapBody.layout.paths.length,
  });

  const adminRoute = await fetch(`${api}/api/navigation/route`, {
    method: "POST",
    headers: bearerHeaders(process.env.ADMIN_API_KEY),
    body: "{}",
  });
  if (adminRoute.status !== 400)
    throw new Error(`Admin navigation access failed: ${adminRoute.status}`);
  console.log("admin navigation access ok");
}

if (process.env.GOGGLE_API_KEY) {
  const headers = bearerHeaders(process.env.GOGGLE_API_KEY);

  // The wearable credential is intentionally scoped: it can calculate a
  // route, but it cannot read or modify the administrator's complete map.
  const scopedMap = await fetch(`${api}/api/store-map`, { headers });
  if (scopedMap.status !== 401)
    throw new Error(`Goggle key escaped navigation scope: ${scopedMap.status}`);

  const invalidRoute = await fetch(`${api}/api/navigation/route`, {
    method: "POST",
    headers,
    body: "{}",
  });
  if (invalidRoute.status !== 400)
    throw new Error(`Goggle navigation access failed: ${invalidRoute.status}`);
  console.log("goggle navigation scope ok");

  const markerId = process.env.SMOKE_ROUTE_MARKER_ID;
  const productId = process.env.SMOKE_ROUTE_PRODUCT_ID;
  const shelfId = process.env.SMOKE_ROUTE_SHELF_ID;
  if (markerId && (productId || shelfId)) {
    const route = await fetch(`${api}/api/navigation/route`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        fromMarkerId: markerId,
        ...(productId ? { toProductId: productId } : { toShelfId: shelfId }),
      }),
    });
    const routeBody = await responseJson(route);
    if (!route.ok)
      throw new Error(`Navigation route failed: ${route.status} ${JSON.stringify(routeBody)}`);
    validateRouteResponse(routeBody);
    console.log("navigation route", {
      markerId: routeBody.fromMarkerId,
      shelfId: routeBody.toShelfId,
      distanceMeters: routeBody.distanceMeters,
      points: routeBody.points.length,
    });
  }
}

if (process.env.MQTT_USERNAME && process.env.MQTT_PASSWORD) {
  const client = mqtt.connect(mqttUrl, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
  });
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  client.publish("intelligenti/readers/SIM001/scan", JSON.stringify({
    deviceId: "SIM001",
    productId: "PRD-00000001",
    tagUid: "04AABBCC",
    rssi: -42,
    uptimeMs: 1000,
  }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  client.end();
  console.log("mqtt scan published");
}
