import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import mysql from "mysql2/promise";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import mqtt from "mqtt";
import QRCode from "qrcode";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const pool = mysql.createPool({
  host: required("DB_HOST"),
  port: Number(process.env.DB_PORT ?? 3306),
  user: required("DB_USER"),
  password: required("DB_PASSWORD"),
  database: required("DB_NAME"),
  waitForConnections: true,
  connectionLimit: 10,
});

const mqttClient = mqtt.connect(required("MQTT_URL"), {
  username: required("MQTT_USERNAME"),
  password: required("MQTT_PASSWORD"),
  clientId: `intelligenti-api-${randomBytes(4).toString("hex")}`,
  clean: true,
  reconnectPeriod: 5000,
});

let mqttConnected = false;

mqttClient.on("connect", () => {
  mqttConnected = true;
  mqttClient.subscribe("intelligenti/readers/+/scan", { qos: 0 }, (error) => {
    if (error) console.error("MQTT subscribe failed", error);
  });
});
mqttClient.on("close", () => { mqttConnected = false; });
mqttClient.on("error", (error) => console.error("MQTT error", error.message));
mqttClient.on("message", async (_topic, payload) => {
  try {
    const scan = JSON.parse(payload.toString("utf8")) as {
      deviceId?: unknown;
      action?: unknown;
      productId?: unknown;
      tagUid?: unknown;
      rssi?: unknown;
    };
    if (typeof scan.deviceId !== "string") return;
    const defaultGoggleId = cleanId(process.env.DEFAULT_GOGGLE_ID ?? "BEAMPRO-01");
    if (scan.action === "reset") {
      if (defaultGoggleId) await clearGoggleTarget(defaultGoggleId);
      return;
    }
    if (typeof scan.productId !== "string") return;
    await pool.execute(
      `INSERT INTO scan_events (reader_id, product_id, tag_uid, wifi_rssi)
       VALUES (?, ?, ?, ?)`,
      [
        scan.deviceId.slice(0, 32),
        scan.productId.slice(0, 32),
        typeof scan.tagUid === "string" ? scan.tagUid.slice(0, 32) : null,
        typeof scan.rssi === "number" ? scan.rssi : null,
      ],
    );
    if (defaultGoggleId) await storeGoggleTarget(defaultGoggleId, scan.productId);
  } catch (error) {
    console.error("Invalid scan message", error);
  }
});

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use((_request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  next();
});
app.options("*path", (_request, response) => response.sendStatus(204));

const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
const uploadDirectory = process.env.UPLOAD_DIR ?? join(runtimeDirectory, "../uploads");
const publicApiBaseUrl = (process.env.PUBLIC_API_BASE_URL ?? "https://nfc-api.tkgon.net").replace(/\/+$/, "");
const maximumImageBytes = 6 * 1024 * 1024;
mkdirSync(uploadDirectory, { recursive: true });

interface ImageFormat {
  extension: ".jpg" | ".png";
  contentType: "image/jpeg" | "image/png";
}

function detectImageFormat(buffer: Buffer): ImageFormat | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return { extension: ".jpg", contentType: "image/jpeg" };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { extension: ".png", contentType: "image/png" };
  return null;
}

const adminSessions = new Map<string, number>();
const adminSessionLifetimeMs = 12 * 60 * 60 * 1000;

function secretMatches(value: string, expected: string): boolean {
  const actualBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer);
}

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.header("Cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return null;
}

function hasAdminSession(request: Request): boolean {
  const token = cookieValue(request, "intelligenti_admin");
  if (!token) return false;
  const expiresAt = adminSessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function bearerToken(request: Request): string {
  return request.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
}

function hasAdminAccess(request: Request): boolean {
  const bearer = bearerToken(request);
  const adminApiKey = process.env.ADMIN_API_KEY ?? "";
  return (bearer.length > 0 && adminApiKey.length > 0 && secretMatches(bearer, adminApiKey)) ||
    hasAdminSession(request);
}

function hasGoggleRouteAccess(request: Request): boolean {
  const bearer = bearerToken(request);
  const goggleApiKey = process.env.GOGGLE_API_KEY ?? "";
  return bearer.length > 0 && goggleApiKey.length > 0 && secretMatches(bearer, goggleApiKey);
}

function hasReaderAccess(request: Request): boolean {
  const bearer = bearerToken(request);
  const readerApiKey = process.env.READER_API_KEY ?? "";
  return bearer.length > 0 && readerApiKey.length > 0 && secretMatches(bearer, readerApiKey);
}

function requireAdmin(request: Request, response: Response, next: NextFunction): void {
  if (!hasAdminAccess(request)) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function requireNavigationAccess(request: Request, response: Response, next: NextFunction): void {
  // GOGGLE_API_KEY is deliberately accepted only by navigation endpoints.
  // It must never inherit the broader product/map administration scope.
  if (!hasAdminAccess(request) && !hasGoggleRouteAccess(request)) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="Intelligenti navigation", scope="navigation:route"');
    response.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.post("/admin/session", (request, response) => {
  const password = typeof request.body.password === "string" ? request.body.password : "";
  if (!secretMatches(password, required("ADMIN_UI_PASSWORD"))) {
    response.status(401).json({ error: "パスワードが違います" });
    return;
  }
  const token = randomBytes(32).toString("hex");
  adminSessions.set(token, Date.now() + adminSessionLifetimeMs);
  response.setHeader(
    "Set-Cookie",
    `intelligenti_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${adminSessionLifetimeMs / 1000}`,
  );
  response.json({ authenticated: true });
});

app.get("/admin/session", (request, response) => {
  if (!hasAdminSession(request)) {
    // An anonymous visitor reaching the login page is a normal state, not an
    // API failure. Keep incorrect password submissions as 401, but let the
    // initial session probe stay quiet in the browser console.
    response.json({ authenticated: false });
    return;
  }
  response.json({ authenticated: true });
});

app.delete("/admin/session", (request, response) => {
  const token = cookieValue(request, "intelligenti_admin");
  if (token) adminSessions.delete(token);
  response.setHeader(
    "Set-Cookie",
    "intelligenti_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
  );
  response.json({ authenticated: false });
});

app.get("/api/reader-provisioning", requireAdmin, (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({
    apiBaseUrl: process.env.PUBLIC_API_BASE_URL ?? "https://nfc-api.tkgon.net",
    apiKey: required("READER_API_KEY"),
  });
});

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,32}$/.test(id) ? id : null;
}

function cleanProductId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,13}$/.test(id) ? id : null;
}

function cleanMarkerId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,64}$/.test(id) ? id : null;
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

function coordinate(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(number) && Math.abs(number) <= 99999 ? number : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value : null;
}

function productId(): string {
  return `PRD-${randomBytes(4).toString("hex").toUpperCase()}`;
}

interface ProductRow extends RowDataPacket {
  id: string;
  name: string;
  description: string;
  price_yen: number;
  stock: number;
  shelf_id: string | null;
  image_url: string | null;
  shelf_offset_x: string;
  shelf_offset_y: string;
  shelf_offset_z: string;
  shelf_name: string | null;
  zone: string | null;
  marker_id: string | null;
  tag_linked: number;
  target_version?: number | string | null;
}

interface ShelfRow extends RowDataPacket {
  id: string;
  name: string;
  zone: string | null;
  markerId: string | null;
  x: string;
  y: string;
  z: string;
  productCount: number;
}

function serializeShelf(row: ShelfRow) {
  return {
    id: row.id,
    name: row.name,
    zone: row.zone ?? "",
    markerId: row.markerId ?? "",
    x: Number(row.x),
    y: Number(row.y),
    z: Number(row.z),
    productCount: Number(row.productCount),
  };
}

const shelfSelect = `
  SELECT s.id, s.name, s.zone, s.marker_id AS markerId,
         s.position_x AS x, s.position_y AS y, s.position_z AS z,
         COUNT(p.id) AS productCount
  FROM shelves s LEFT JOIN products p ON p.shelf_id = s.id`;

async function shelfById(id: string): Promise<ShelfRow | null> {
  const [rows] = await pool.execute<ShelfRow[]>(
    `${shelfSelect} WHERE s.id = ? GROUP BY s.id ORDER BY s.id`,
    [id],
  );
  return rows[0] ?? null;
}

async function markerIsAvailable(markerId: string | null, shelfId: string): Promise<boolean> {
  if (!markerId) return true;
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT id FROM shelves WHERE marker_id = ? AND id <> ? LIMIT 1",
    [markerId, shelfId],
  );
  return rows.length === 0;
}

function markerPayload(markerId: string): string {
  return `INTELLIGENTI:${markerId}`;
}

function serializeProduct(row: ProductRow) {
  const product = {
    id: row.id,
    name: row.name,
    description: row.description,
    price: `¥${Number(row.price_yen).toLocaleString("ja-JP")}`,
    priceYen: Number(row.price_yen),
    stock: Number(row.stock),
    shelfId: row.shelf_id ?? "",
    shelfName: row.shelf_name ?? "",
    zone: row.zone ?? "",
    markerId: row.marker_id ?? "",
    tagLinked: Number(row.tag_linked) === 1,
    imageUrl: row.image_url ?? "",
    shelfOffset: {
      x: Number(row.shelf_offset_x),
      y: Number(row.shelf_offset_y),
      z: Number(row.shelf_offset_z),
    },
  };
  return row.target_version == null
    ? product
    : { ...product, targetVersion: Number(row.target_version) };
}

const productSelect = `
  SELECT p.id, p.name, p.description, p.price_yen, p.stock, p.shelf_id,
         p.image_url, p.shelf_offset_x, p.shelf_offset_y, p.shelf_offset_z,
         s.name AS shelf_name, s.zone, s.marker_id,
         EXISTS(
           SELECT 1 FROM scan_events se
           WHERE se.product_id = p.id
             AND se.tag_uid IS NOT NULL
             AND TRIM(se.tag_uid) <> ''
         ) AS tag_linked
  FROM products p LEFT JOIN shelves s ON s.id = p.shelf_id`;

let goggleTargetVersionColumnPromise: Promise<void> | null = null;

function ensureGoggleTargetVersionColumn(): Promise<void> {
  if (goggleTargetVersionColumnPromise) return goggleTargetVersionColumnPromise;
  goggleTargetVersionColumnPromise = (async () => {
    const [columns] = await pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema=DATABASE() AND table_name='goggle_targets'
         AND column_name='version' LIMIT 1`,
    );
    if (columns.length === 0) {
      await pool.execute(
        "ALTER TABLE goggle_targets ADD COLUMN version BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER product_id",
      );
    }
  })().catch((error) => {
    goggleTargetVersionColumnPromise = null;
    throw error;
  });
  return goggleTargetVersionColumnPromise;
}

async function storeGoggleTarget(goggleId: string, targetProductId: string): Promise<void> {
  await ensureGoggleTargetVersionColumn();
  await pool.execute(
    `INSERT INTO goggle_targets (goggle_id, product_id, version)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE product_id=VALUES(product_id),
       version=version+1, updated_at=CURRENT_TIMESTAMP`,
    [goggleId, targetProductId],
  );
}

async function clearGoggleTarget(goggleId: string): Promise<void> {
  await pool.execute("DELETE FROM goggle_targets WHERE goggle_id=?", [goggleId]);
  mqttClient.publish(`intelligenti/goggles/${goggleId}/target`, "", {
    qos: 0,
    retain: true,
  });
}

interface MapPoint { x: number; y: number }
interface MapShelf {
  id: string; shelfId: string; x: number; y: number; width: number; depth: number;
  rotation: number; accessSide: "top" | "right" | "bottom" | "left";
}
interface MapMarker {
  id: string; markerId: string; label: string; x: number; y: number; rotation: number;
}
interface MapPath { id: string; points: MapPoint[] }
interface StoreMapLayout {
  name: string; width: number; depth: number;
  shelves: MapShelf[]; markers: MapMarker[]; paths: MapPath[];
}

interface NavigationRouteResponse {
  schemaVersion: 1;
  mapVersion: number;
  coordinateSystem: "x-right-y-down-meters-rotation-clockwise-from-north";
  fromMarkerId: string;
  toProductId: string | null;
  toShelfId: string;
  distanceMeters: number;
  startMarker: {
    markerId: string;
    label: string;
    position: MapPoint;
    rotationDegrees: number;
  };
  destination: MapPoint;
  points: MapPoint[];
}

const navigationCoordinateSystem: NavigationRouteResponse["coordinateSystem"] =
  "x-right-y-down-meters-rotation-clockwise-from-north";

const defaultStoreMap = (): StoreMapLayout => ({
  name: "店舗マップ",
  width: 24,
  depth: 16,
  shelves: [],
  markers: [],
  paths: [],
});

function finiteInRange(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function normalizeStoreMap(value: unknown): StoreMapLayout | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const width = finiteInRange(raw.width, 4, 200);
  const depth = finiteInRange(raw.depth, 4, 200);
  const name = typeof raw.name === "string" && raw.name.trim()
    ? raw.name.trim().slice(0, 100) : "店舗マップ";
  if (width == null || depth == null || !Array.isArray(raw.shelves) ||
      !Array.isArray(raw.markers) || !Array.isArray(raw.paths) ||
      raw.shelves.length > 300 || raw.markers.length > 300 || raw.paths.length > 600)
    return null;

  const clampPoint = (point: unknown): MapPoint | null => {
    if (!point || typeof point !== "object") return null;
    const candidate = point as Record<string, unknown>;
    const x = finiteInRange(candidate.x, 0, width);
    const y = finiteInRange(candidate.y, 0, depth);
    return x == null || y == null ? null : { x, y };
  };

  const shelves: MapShelf[] = [];
  const shelfIds = new Set<string>();
  for (const entry of raw.shelves) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const shelfId = cleanId(item.shelfId);
    const id = cleanId(item.id) ?? shelfId;
    const point = clampPoint(item);
    const shelfWidth = finiteInRange(item.width, 0.3, width);
    const shelfDepth = finiteInRange(item.depth, 0.3, depth);
    const rotation = finiteInRange(item.rotation, -360, 360);
    const accessSide = item.accessSide;
    if (!id || !shelfId || !point || shelfWidth == null || shelfDepth == null ||
        rotation == null || !["top", "right", "bottom", "left"].includes(String(accessSide)) ||
        shelfIds.has(shelfId)) return null;
    shelfIds.add(shelfId);
    shelves.push({ id, shelfId, ...point, width: shelfWidth, depth: shelfDepth,
      rotation, accessSide: accessSide as MapShelf["accessSide"] });
  }

  const markers: MapMarker[] = [];
  const markerIds = new Set<string>();
  for (const entry of raw.markers) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const markerId = cleanMarkerId(item.markerId);
    const id = cleanId(item.id) ?? markerId;
    const point = clampPoint(item);
    const rotation = finiteInRange(item.rotation, -360, 360);
    if (!id || !markerId || !point || rotation == null || markerIds.has(markerId)) return null;
    markerIds.add(markerId);
    markers.push({ id, markerId, label: optionalText(item.label, 100) ?? markerId,
      ...point, rotation });
  }

  const paths: MapPath[] = [];
  const pathIds = new Set<string>();
  for (const entry of raw.paths) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = cleanId(item.id);
    if (!id || pathIds.has(id) || !Array.isArray(item.points) ||
        item.points.length < 2 || item.points.length > 100) return null;
    const points = item.points.map(clampPoint);
    if (points.some((point) => point == null)) return null;
    pathIds.add(id);
    paths.push({ id, points: points as MapPoint[] });
  }
  return { name, width, depth, shelves, markers, paths };
}

async function ensureStoreMapTable(): Promise<void> {
  await pool.execute(`CREATE TABLE IF NOT EXISTS store_map (
    id TINYINT UNSIGNED NOT NULL DEFAULT 1,
    name VARCHAR(100) NOT NULL DEFAULT '店舗マップ',
    width_m DECIMAL(8,2) NOT NULL DEFAULT 24.00,
    depth_m DECIMAL(8,2) NOT NULL DEFAULT 16.00,
    layout_json JSON NOT NULL,
    version INT UNSIGNED NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

async function readStoreMap(): Promise<{ layout: StoreMapLayout; version: number; updatedAt: unknown }> {
  await ensureStoreMapTable();
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT layout_json AS layout, version, updated_at AS updatedAt FROM store_map WHERE id=1",
  );
  if (rows.length === 0) return { layout: defaultStoreMap(), version: 0, updatedAt: null };
  const rawLayout = typeof rows[0].layout === "string" ? JSON.parse(rows[0].layout) : rows[0].layout;
  return { layout: normalizeStoreMap(rawLayout) ?? defaultStoreMap(),
    version: Number(rows[0].version), updatedAt: rows[0].updatedAt };
}

function rotatePoint(point: MapPoint, degrees: number): MapPoint {
  const radians = degrees * Math.PI / 180;
  return { x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: point.x * Math.sin(radians) + point.y * Math.cos(radians) };
}

function shelfAccessPoint(shelf: MapShelf): MapPoint {
  const clearance = 0.1;
  const local = shelf.accessSide === "top" ? { x: 0, y: -shelf.depth / 2 - clearance }
    : shelf.accessSide === "right" ? { x: shelf.width / 2 + clearance, y: 0 }
    : shelf.accessSide === "bottom" ? { x: 0, y: shelf.depth / 2 + clearance }
    : { x: -shelf.width / 2 - clearance, y: 0 };
  const rotated = rotatePoint(local, shelf.rotation);
  return { x: shelf.x + rotated.x, y: shelf.y + rotated.y };
}

function pointDistance(a: MapPoint, b: MapPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function serializeMapPoint(point: MapPoint): MapPoint {
  return { x: Number(point.x.toFixed(3)), y: Number(point.y.toFixed(3)) };
}

function normalizeRotationDegrees(value: number): number {
  return Number((((value % 360) + 360) % 360).toFixed(3));
}

function segmentIntersection(a: MapPoint, b: MapPoint, c: MapPoint, d: MapPoint): MapPoint | null {
  const denominator = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (Math.abs(denominator) < 1e-8) return null;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denominator;
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / denominator;
  if (t < -1e-6 || t > 1.000001 || u < -1e-6 || u > 1.000001) return null;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

function closestPointOnSegment(point: MapPoint, a: MapPoint, b: MapPoint): MapPoint {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-8) return a;
  const t = clampNumber(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function routeOnLayout(layout: StoreMapLayout, start: MapPoint, destination: MapPoint): MapPoint[] | null {
  const segments: Array<{ a: MapPoint; b: MapPoint; cuts: MapPoint[] }> = [];
  for (const path of layout.paths) for (let index = 1; index < path.points.length; index++) {
    const a = path.points[index - 1];
    const b = path.points[index];
    if (pointDistance(a, b) > 0.01) segments.push({ a, b, cuts: [a, b] });
  }
  for (const attachment of [start, destination]) {
    let best: { segment: typeof segments[number]; point: MapPoint; distance: number } | null = null;
    for (const segment of segments) {
      const point = closestPointOnSegment(attachment, segment.a, segment.b);
      const distance = pointDistance(attachment, point);
      if (!best || distance < best.distance) best = { segment, point, distance };
    }
    if (best && best.distance <= 2.5) best.segment.cuts.push(best.point);
  }
  for (let left = 0; left < segments.length; left++) for (let right = left + 1; right < segments.length; right++) {
    const point = segmentIntersection(segments[left].a, segments[left].b, segments[right].a, segments[right].b);
    if (point) { segments[left].cuts.push(point); segments[right].cuts.push(point); }
  }

  const points: MapPoint[] = [];
  const adjacency: Array<Array<{ to: number; distance: number }>> = [];
  const pointIndex = (point: MapPoint): number => {
    const existing = points.findIndex((candidate) => pointDistance(candidate, point) < 0.015);
    if (existing >= 0) return existing;
    points.push(point); adjacency.push([]); return points.length - 1;
  };
  const connect = (a: MapPoint, b: MapPoint) => {
    const from = pointIndex(a); const to = pointIndex(b); const distance = pointDistance(a, b);
    adjacency[from].push({ to, distance }); adjacency[to].push({ to: from, distance });
  };
  for (const segment of segments) {
    const length = pointDistance(segment.a, segment.b);
    const cuts = segment.cuts
      .filter((point, index, all) => all.findIndex((other) => pointDistance(point, other) < 0.015) === index)
      .sort((one, two) => pointDistance(segment.a, one) / length - pointDistance(segment.a, two) / length);
    for (let index = 1; index < cuts.length; index++) connect(cuts[index - 1], cuts[index]);
  }
  if (points.length === 0) return null;
  const nearest = (point: MapPoint) => points.reduce((best, candidate, index) =>
    pointDistance(point, candidate) < best.distance ? { index, distance: pointDistance(point, candidate) } : best,
    { index: -1, distance: Number.POSITIVE_INFINITY });
  const startNode = nearest(start); const endNode = nearest(destination);
  if (startNode.index < 0 || endNode.index < 0 || startNode.distance > 2.5 || endNode.distance > 2.5) return null;

  const distances = points.map(() => Number.POSITIVE_INFINITY);
  const previous = points.map(() => -1);
  const visited = new Set<number>();
  distances[startNode.index] = 0;
  while (visited.size < points.length) {
    let current = -1;
    for (let index = 0; index < points.length; index++)
      if (!visited.has(index) && (current < 0 || distances[index] < distances[current])) current = index;
    if (current < 0 || !Number.isFinite(distances[current]) || current === endNode.index) break;
    visited.add(current);
    for (const edge of adjacency[current]) {
      const nextDistance = distances[current] + edge.distance;
      if (nextDistance < distances[edge.to]) { distances[edge.to] = nextDistance; previous[edge.to] = current; }
    }
  }
  if (!Number.isFinite(distances[endNode.index])) return null;
  const indices: number[] = [];
  for (let at = endNode.index; at >= 0; at = previous[at]) {
    indices.push(at); if (at === startNode.index) break;
  }
  indices.reverse();
  return [start, ...indices.map((index) => points[index]), destination]
    .filter((point, index, all) => index === 0 || pointDistance(point, all[index - 1]) > 0.01);
}

app.get("/api/store-map", requireAdmin, async (_request, response) => {
  const map = await readStoreMap();
  response.setHeader("Cache-Control", "no-store");
  response.json(map);
});

app.put("/api/store-map", requireAdmin, async (request, response) => {
  const layout = normalizeStoreMap(request.body);
  if (!layout) return response.status(400).json({ error: "マップの形式が正しくありません" });
  const [knownShelves] = await pool.execute<RowDataPacket[]>("SELECT id FROM shelves");
  const knownShelfIds = new Set(knownShelves.map((row) => String(row.id)));
  const unknownShelf = layout.shelves.find((shelf) => !knownShelfIds.has(shelf.shelfId));
  if (unknownShelf) return response.status(400).json({ error: `${unknownShelf.shelfId} は売場構成に登録されていません` });
  await ensureStoreMapTable();
  await pool.execute(
    `INSERT INTO store_map (id, name, width_m, depth_m, layout_json, version)
     VALUES (1, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE name=VALUES(name), width_m=VALUES(width_m),
       depth_m=VALUES(depth_m), layout_json=VALUES(layout_json), version=version+1`,
    [layout.name, layout.width, layout.depth, JSON.stringify(layout)],
  );
  const saved = await readStoreMap();
  response.json(saved);
});

app.post("/api/navigation/route", requireNavigationAccess, async (request, response) => {
  const markerId = cleanMarkerId(request.body.fromMarkerId);
  let shelfId = cleanId(request.body.toShelfId);
  const productIdValue = request.body.toProductId == null ? null : cleanId(request.body.toProductId);
  if (!markerId || (!shelfId && !productIdValue))
    return response.status(400).json({ error: "開始QRと目的の商品または棚が必要" });
  if (!shelfId && productIdValue) {
    const [products] = await pool.execute<RowDataPacket[]>("SELECT shelf_id AS shelfId FROM products WHERE id=?", [productIdValue]);
    shelfId = products.length ? cleanId(products[0].shelfId) : null;
    if (!shelfId) return response.status(400).json({ error: "この商品には棚が割り当てられていません" });
  }
  const { layout, version: mapVersion } = await readStoreMap();
  const marker = layout.markers.find((entry) => entry.markerId === markerId);
  const shelf = layout.shelves.find((entry) => entry.shelfId === shelfId);
  if (!marker) return response.status(404).json({ error: `${markerId} はマップに配置されていません` });
  if (!shelf) return response.status(404).json({ error: `${shelfId} はマップに配置されていません` });
  const destination = shelfAccessPoint(shelf);
  const points = routeOnLayout(layout, marker, destination);
  if (!points) return response.status(422).json({
    error: "QRまたは棚が通路に未接続。近くまで通路を追加",
  });
  const distanceMeters = points.slice(1).reduce((sum, point, index) => sum + pointDistance(points[index], point), 0);
  const routeResponse: NavigationRouteResponse = {
    schemaVersion: 1,
    mapVersion,
    coordinateSystem: navigationCoordinateSystem,
    fromMarkerId: marker.markerId,
    toProductId: productIdValue,
    toShelfId: shelf.shelfId,
    distanceMeters: Number(distanceMeters.toFixed(1)),
    startMarker: {
      markerId: marker.markerId,
      label: marker.label,
      position: serializeMapPoint(marker),
      rotationDegrees: normalizeRotationDegrees(marker.rotation),
    },
    destination: serializeMapPoint(destination),
    points: points.map(serializeMapPoint),
  };
  response.setHeader("Cache-Control", "no-store");
  response.json(routeResponse);
});

app.get("/health", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    response.json({ status: "ok", database: "connected", mqtt: mqttConnected ? "connected" : "disconnected" });
  } catch {
    response.status(503).json({ status: "error", database: "disconnected", mqtt: mqttConnected ? "connected" : "disconnected" });
  }
});

app.get("/api/products", async (request, response) => {
  const query = typeof request.query.q === "string" ? request.query.q.trim() : "";
  const limit = Math.min(Math.max(Number(request.query.limit ?? 50) || 50, 1), 100);
  const [rows] = query
    ? await pool.execute<ProductRow[]>(`${productSelect} WHERE p.name LIKE ? OR p.id = ? ORDER BY p.name LIMIT ${limit}`, [`%${query}%`, query.toUpperCase()])
    : await pool.execute<ProductRow[]>(`${productSelect} ORDER BY p.name LIMIT ${limit}`);
  response.json(rows.map(serializeProduct));
});

app.get("/api/products/:id", async (request, response) => {
  const id = cleanId(request.params.id);
  if (!id) return response.status(400).json({ error: "Invalid product ID" });
  const [rows] = await pool.execute<ProductRow[]>(`${productSelect} WHERE p.id = ?`, [id]);
  if (rows.length === 0) return response.status(404).json({ error: "Product not found" });
  response.json(serializeProduct(rows[0]));
});

app.post(
  "/api/product-images",
  requireAdmin,
  express.raw({ type: ["image/jpeg", "image/png"], limit: maximumImageBytes }),
  async (request, response) => {
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      response.status(400).json({ error: "画像ファイルを選択してください" });
      return;
    }
    const format = detectImageFormat(request.body);
    if (!format) {
      response.status(415).json({ error: "JPEG・PNG形式の画像を選択してください" });
      return;
    }
    const filename = `${randomBytes(16).toString("hex")}${format.extension}`;
    await writeFile(join(uploadDirectory, filename), request.body, { flag: "wx" });
    console.info(`Product image uploaded: ${filename} (${request.body.length} bytes)`);
    response.status(201).json({
      imageUrl: `${publicApiBaseUrl}/uploads/${filename}`,
      contentType: format.contentType,
    });
  },
);

app.post("/api/products", requireAdmin, async (request, response) => {
  const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
  const description = typeof request.body.description === "string" ? request.body.description.trim() : "";
  const price = nonNegativeInteger(request.body.priceYen);
  const stock = nonNegativeInteger(request.body.stock ?? 0);
  const shelfId = request.body.shelfId == null || request.body.shelfId === "" ? null : cleanId(request.body.shelfId);
  const id = request.body.id == null || request.body.id === "" ? productId() : cleanProductId(request.body.id);
  const offsetX = coordinate(request.body.shelfOffset?.x);
  const offsetY = coordinate(request.body.shelfOffset?.y);
  const offsetZ = coordinate(request.body.shelfOffset?.z);
  if (!id || !name || name.length > 120 || description.length > 5000 || price == null || stock == null ||
      (request.body.shelfId && !shelfId) || offsetX == null || offsetY == null || offsetZ == null)
    return response.status(400).json({ error: "Invalid product" });
  await pool.execute<ResultSetHeader>(
    `INSERT INTO products (id, name, description, price_yen, stock, shelf_id, image_url,
                           shelf_offset_x, shelf_offset_y, shelf_offset_z)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, description, price, stock, shelfId,
      typeof request.body.imageUrl === "string" ? request.body.imageUrl : null,
      offsetX, offsetY, offsetZ],
  );
  const [rows] = await pool.execute<ProductRow[]>(`${productSelect} WHERE p.id = ?`, [id]);
  response.status(201).json(serializeProduct(rows[0]));
});

app.put("/api/products/:id", requireAdmin, async (request, response) => {
  const id = cleanId(request.params.id);
  const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
  const description = typeof request.body.description === "string" ? request.body.description.trim() : "";
  const price = nonNegativeInteger(request.body.priceYen);
  const stock = nonNegativeInteger(request.body.stock);
  const shelfId = request.body.shelfId == null || request.body.shelfId === "" ? null : cleanId(request.body.shelfId);
  const offsetX = coordinate(request.body.shelfOffset?.x);
  const offsetY = coordinate(request.body.shelfOffset?.y);
  const offsetZ = coordinate(request.body.shelfOffset?.z);
  if (!id || !name || name.length > 120 || description.length > 5000 || price == null || stock == null ||
      (request.body.shelfId && !shelfId) || offsetX == null || offsetY == null || offsetZ == null)
    return response.status(400).json({ error: "Invalid product" });
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE products SET name=?, description=?, price_yen=?, stock=?, shelf_id=?, image_url=?,
                         shelf_offset_x=?, shelf_offset_y=?, shelf_offset_z=? WHERE id=?`,
    [name, description, price, stock, shelfId,
      typeof request.body.imageUrl === "string" ? request.body.imageUrl : null,
      offsetX, offsetY, offsetZ, id],
  );
  if (result.affectedRows === 0) return response.status(404).json({ error: "Product not found" });
  const [rows] = await pool.execute<ProductRow[]>(`${productSelect} WHERE p.id = ?`, [id]);
  response.json(serializeProduct(rows[0]));
});

app.delete("/api/products/:id", requireAdmin, async (request, response) => {
  const id = cleanId(request.params.id);
  if (!id) return response.status(400).json({ error: "Invalid product ID" });
  const [result] = await pool.execute<ResultSetHeader>("DELETE FROM products WHERE id = ?", [id]);
  if (result.affectedRows === 0) return response.status(404).json({ error: "Product not found" });
  response.json({ id, deleted: true });
});

app.get("/api/shelves", async (_request, response) => {
  const [rows] = await pool.execute<ShelfRow[]>(
    `${shelfSelect} GROUP BY s.id ORDER BY s.id`,
  );
  response.json(rows.map(serializeShelf));
});

app.post("/api/shelves", requireAdmin, async (request, response) => {
  const id = cleanId(request.body.id);
  const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
  const zone = optionalText(request.body.zone, 100);
  const markerId = request.body.markerId == null || request.body.markerId === ""
    ? null : cleanMarkerId(request.body.markerId);
  const x = coordinate(request.body.x);
  const y = coordinate(request.body.y);
  const z = coordinate(request.body.z);
  if (!id || !name || name.length > 100 || (request.body.zone && !zone) ||
      (request.body.markerId && !markerId) || x == null || y == null || z == null)
    return response.status(400).json({ error: "売場情報の形式が正しくありません" });
  if (!(await markerIsAvailable(markerId, id)))
    return response.status(409).json({ error: "このマーカーIDは別の売場に割り当て済みです" });
  await pool.execute(
    `INSERT INTO shelves (id, name, zone, marker_id, position_x, position_y, position_z)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, name, zone, markerId, x, y, z],
  );
  const shelf = await shelfById(id);
  response.status(201).json(serializeShelf(shelf!));
});

app.put("/api/shelves/:id", requireAdmin, async (request, response) => {
  const id = cleanId(request.params.id);
  const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
  const zone = optionalText(request.body.zone, 100);
  const markerId = request.body.markerId == null || request.body.markerId === ""
    ? null : cleanMarkerId(request.body.markerId);
  const x = coordinate(request.body.x);
  const y = coordinate(request.body.y);
  const z = coordinate(request.body.z);
  if (!id || !name || name.length > 100 || (request.body.zone && !zone) ||
      (request.body.markerId && !markerId) || x == null || y == null || z == null)
    return response.status(400).json({ error: "売場情報の形式が正しくありません" });
  if (!(await markerIsAvailable(markerId, id)))
    return response.status(409).json({ error: "このマーカーIDは別の売場に割り当て済みです" });

  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE shelves SET name=?, zone=?, marker_id=?, position_x=?, position_y=?, position_z=?
     WHERE id=?`,
    [name, zone, markerId, x, y, z, id],
  );
  if (result.affectedRows === 0) return response.status(404).json({ error: "売場が見つかりません" });
  const shelf = await shelfById(id);
  response.json(serializeShelf(shelf!));
});

app.get("/api/markers/:markerId", async (request, response) => {
  const markerId = cleanMarkerId(request.params.markerId);
  if (!markerId) return response.status(400).json({ error: "Invalid marker ID" });
  const { layout } = await readStoreMap();
  const locationMarker = layout.markers.find((entry) => entry.markerId === markerId);
  if (locationMarker) return response.json({
    markerId,
    shelf: {
      id: `LOCATION-${markerId}`.slice(0, 32), name: locationMarker.label,
      zone: "現在地", markerId, x: locationMarker.x, y: locationMarker.y, z: 0, productCount: 0,
    },
    products: [],
  });
  const [shelves] = await pool.execute<ShelfRow[]>(
    `${shelfSelect} WHERE s.marker_id = ? GROUP BY s.id LIMIT 1`,
    [markerId],
  );
  if (shelves.length === 0) return response.status(404).json({ error: "Marker not assigned" });
  const [products] = await pool.execute<ProductRow[]>(
    `${productSelect} WHERE s.marker_id = ? ORDER BY p.name`,
    [markerId],
  );
  response.json({
    markerId,
    shelf: serializeShelf(shelves[0]),
    products: products.map(serializeProduct),
  });
});

app.get("/api/markers/:markerId/image.svg", async (request, response) => {
  const markerId = cleanMarkerId(request.params.markerId);
  if (!markerId) return response.status(400).send("Invalid marker ID");
  const svg = await QRCode.toString(markerPayload(markerId), {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 4,
    width: 1024,
    color: { dark: "#171a17", light: "#fffdf7" },
  });
  response.type("image/svg+xml");
  response.setHeader("Cache-Control", "public, max-age=3600");
  response.send(svg);
});

app.get("/api/scan-events", requireAdmin, async (_request, response) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT id, reader_id AS readerId, product_id AS productId, tag_uid AS tagUid, wifi_rssi AS rssi, scanned_at AS scannedAt FROM scan_events ORDER BY id DESC LIMIT 100",
  );
  response.json(rows);
});

app.post("/api/reader-scans", async (request, response) => {
  if (!hasReaderAccess(request)) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="Intelligenti reader", scope="reader:scan"');
    return response.status(401).json({ error: "Unauthorized" });
  }

  const readerId = cleanId(request.body.deviceId);
  const action = request.body.action === "reset" ? "reset" : "scan";
  const tagUid = optionalText(request.body.tagUid, 32);
  if (!readerId) return response.status(400).json({ error: "Invalid reader ID" });
  if (action === "reset") {
    const goggleId = cleanId(process.env.DEFAULT_GOGGLE_ID ?? "BEAMPRO-01");
    if (goggleId) await clearGoggleTarget(goggleId);
    return response.status(201).json({ accepted: true, action, readerId, tagUid, goggleId });
  }
  const id = cleanProductId(request.body.productId);
  const rssi = typeof request.body.rssi === "number" && Number.isFinite(request.body.rssi)
    ? Math.round(request.body.rssi)
    : null;
  if (!id) return response.status(400).json({ error: "Invalid scan" });

  const [products] = await pool.execute<ProductRow[]>(`${productSelect} WHERE p.id = ?`, [id]);
  if (products.length === 0) return response.status(404).json({ error: "Product not found" });

  await pool.execute(
    `INSERT INTO scan_events (reader_id, product_id, tag_uid, wifi_rssi)
     VALUES (?, ?, ?, ?)`,
    [readerId, id, tagUid, rssi],
  );
  const goggleId = cleanId(process.env.DEFAULT_GOGGLE_ID ?? "BEAMPRO-01");
  if (goggleId) await storeGoggleTarget(goggleId, id);
  response.status(201).json({ accepted: true, readerId, productId: id, goggleId });
});

app.post("/api/goggles/:goggleId/target", requireAdmin, async (request, response) => {
  const goggleId = cleanId(request.params.goggleId);
  const id = cleanId(request.body.productId);
  if (!goggleId || !id) return response.status(400).json({ error: "Invalid target" });
  const [rows] = await pool.execute<ProductRow[]>(`${productSelect} WHERE p.id = ?`, [id]);
  if (rows.length === 0) return response.status(404).json({ error: "Product not found" });
  await storeGoggleTarget(goggleId, id);
  const topic = `intelligenti/goggles/${goggleId}/target`;
  mqttClient.publish(topic, JSON.stringify(serializeProduct(rows[0])), { qos: 0, retain: true });
  response.json({ topic, productId: id, published: true });
});

app.get("/api/goggles/:goggleId/target", async (request, response) => {
  const goggleId = cleanId(request.params.goggleId);
  if (!goggleId) return response.status(400).json({ error: "Invalid goggle ID" });
  await ensureGoggleTargetVersionColumn();
  const [rows] = await pool.execute<ProductRow[]>(
    `SELECT target_product.*, gt.version AS target_version
     FROM (${productSelect}) AS target_product
     INNER JOIN goggle_targets gt ON gt.product_id = target_product.id
     WHERE gt.goggle_id = ? LIMIT 1`,
    [goggleId],
  );
  if (rows.length === 0) return response.sendStatus(204);
  response.setHeader("Cache-Control", "no-store");
  response.json(serializeProduct(rows[0]));
});

const publicDirectory = join(runtimeDirectory, "../public");
app.get("/", (_request, response) => response.redirect("/admin/"));
app.use("/admin", express.static(publicDirectory, { index: "index.html" }));
app.use("/uploads", express.static(uploadDirectory, {
  immutable: true,
  maxAge: "1y",
  setHeaders: (response) => response.setHeader("X-Content-Type-Options", "nosniff"),
}));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (typeof error === "object" && error !== null && "status" in error && error.status === 413) {
    response.status(413).json({ error: "画像は6MB以内にしてください" });
    return;
  }
  console.error(error);
  response.status(500).json({ error: "Internal server error" });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, "0.0.0.0", () => console.log(`Intelligenti API listening on ${port}`));
