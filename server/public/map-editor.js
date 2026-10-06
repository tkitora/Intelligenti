(() => {
  "use strict";

  const editor = {
    loaded: false,
    loading: false,
    dirty: false,
    map: null,
    shelves: [],
    products: [],
    selected: null,
    undo: [],
    redo: [],
    drawing: false,
    drawStart: null,
    previewEnd: null,
    routePoints: [],
    measurements: localStorage.getItem("intelligenti-map-measurements") !== "hidden",
  };

  const byId = (id) => document.getElementById(id);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  const snap = (value) => Math.round(value * 4) / 4;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `通信エラー (${response.status})`);
    return data;
  }

  function notify(message, isError = false) {
    const toast = byId("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.classList.add("show");
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => toast.classList.remove("show"), 2800);
  }

  function pushHistory() {
    editor.undo.push(clone(editor.map));
    if (editor.undo.length > 60) editor.undo.shift();
    editor.redo.length = 0;
    markDirty();
  }

  function markDirty() {
    editor.dirty = true;
    byId("mapSaveState").textContent = "未保存の変更あり";
    byId("mapSaveState").className = "map-save-state is-dirty";
    updateHistoryButtons();
  }

  function markSaved(updatedAt) {
    editor.dirty = false;
    const label = updatedAt ? new Date(updatedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "いま";
    byId("mapSaveState").textContent = `${label} 保存済み`;
    byId("mapSaveState").className = "map-save-state is-saved";
  }

  function updateHistoryButtons() {
    byId("mapUndo").disabled = editor.undo.length === 0;
    byId("mapRedo").disabled = editor.redo.length === 0;
  }

  function stagePoint(event) {
    const rect = byId("storeMapStage").getBoundingClientRect();
    return {
      x: snap(clamp((event.clientX - rect.left) / rect.width * editor.map.width, 0, editor.map.width)),
      y: snap(clamp((event.clientY - rect.top) / rect.height * editor.map.depth, 0, editor.map.depth)),
    };
  }

  function objectBySelection() {
    if (!editor.selected) return null;
    const collection = editor.selected.type === "shelf" ? editor.map.shelves
      : editor.selected.type === "marker" ? editor.map.markers : editor.map.paths;
    return collection.find((item) => item.id === editor.selected.id) || null;
  }

  function shelfName(shelfId) {
    return editor.shelves.find((item) => item.id === shelfId)?.name || shelfId;
  }

  function render() {
    if (!editor.map) return;
    const stage = byId("storeMapStage");
    stage.style.aspectRatio = `${editor.map.width} / ${editor.map.depth}`;
    stage.style.setProperty("--meter-x", `${100 / editor.map.width}%`);
    stage.style.setProperty("--meter-y", `${100 / editor.map.depth}%`);
    stage.style.setProperty("--half-meter-x", `${50 / editor.map.width}%`);
    stage.style.setProperty("--half-meter-y", `${50 / editor.map.depth}%`);
    stage.classList.toggle("measurements-hidden", !editor.measurements);
    byId("toggleMapMeasures").setAttribute("aria-pressed", String(editor.measurements));
    byId("toggleMapMeasures").textContent = editor.measurements ? "寸法を隠す" : "寸法を表示";
    byId("mapSizeBadge").textContent = `横 ${editor.map.width}m × 奥行 ${editor.map.depth}m｜1マス 1m`;
    byId("mapWidth").value = editor.map.width;
    byId("mapDepth").value = editor.map.depth;
    renderPaths();
    renderObjects();
    renderInspector();
    renderSelectors();
    byId("mapEmptyGuide").classList.toggle("is-hidden",
      editor.map.shelves.length + editor.map.markers.length + editor.map.paths.length > 0);
    updateHistoryButtons();
  }

  function svgLine(svg, a, b, className, id = "") {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", a.x); line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x); line.setAttribute("y2", b.y);
    line.setAttribute("class", className);
    if (id) line.dataset.id = id;
    svg.append(line);
    return line;
  }

  function svgMeasure(svg, a, b) {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", String((a.x + b.x) / 2));
    text.setAttribute("y", String((a.y + b.y) / 2 - 0.18));
    text.setAttribute("class", "map-path-measure");
    text.textContent = `${length.toFixed(1)}m`;
    svg.append(text);
  }

  function svgPathHandle(svg, path, pointIndex) {
    const point = path.points[pointIndex];
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", point.x); circle.setAttribute("cy", point.y);
    circle.setAttribute("r", ".22"); circle.setAttribute("class", "map-path-handle");
    circle.addEventListener("pointerdown", (event) => beginPathEndpointDrag(event, path.id, pointIndex));
    svg.append(circle);
  }

  function renderPaths() {
    const svg = byId("mapPathLayer");
    svg.replaceChildren();
    svg.setAttribute("viewBox", `0 0 ${editor.map.width} ${editor.map.depth}`);
    for (const path of editor.map.paths) {
      for (let index = 1; index < path.points.length; index++) {
        svgLine(svg, path.points[index - 1], path.points[index],
          `map-path${editor.selected?.type === "path" && editor.selected.id === path.id ? " is-selected" : ""}`);
        const hit = svgLine(svg, path.points[index - 1], path.points[index], "map-path-hit", path.id);
        hit.addEventListener("pointerdown", (event) => beginPathDrag(event, path.id));
        svgMeasure(svg, path.points[index - 1], path.points[index]);
      }
      if (editor.selected?.type === "path" && editor.selected.id === path.id && path.points.length > 1) {
        svgPathHandle(svg, path, 0);
        svgPathHandle(svg, path, path.points.length - 1);
      }
    }
    if (editor.drawing && editor.drawStart && editor.previewEnd) {
      svgLine(svg, editor.drawStart, editor.previewEnd, "map-path is-preview");
      svgMeasure(svg, editor.drawStart, editor.previewEnd);
    }
    if (editor.routePoints.length > 1) {
      const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      polyline.setAttribute("points", editor.routePoints.map((point) => `${point.x},${point.y}`).join(" "));
      polyline.setAttribute("class", "map-route");
      svg.append(polyline);
    }
  }

  function renderObjects() {
    const layer = byId("mapObjectLayer");
    layer.replaceChildren();
    for (const shelf of editor.map.shelves) {
      const element = document.createElement("button");
      element.type = "button";
      element.className = `map-shelf-object${editor.selected?.type === "shelf" && editor.selected.id === shelf.id ? " is-selected" : ""}`;
      element.style.left = `${shelf.x / editor.map.width * 100}%`;
      element.style.top = `${shelf.y / editor.map.depth * 100}%`;
      element.style.width = `${shelf.width / editor.map.width * 100}%`;
      element.style.height = `${shelf.depth / editor.map.depth * 100}%`;
      element.style.transform = `translate(-50%, -50%) rotate(${shelf.rotation}deg)`;
      element.setAttribute("aria-label", `${shelfName(shelf.shelfId)}。ドラッグして移動`);
      const label = document.createElement("span"); label.textContent = shelfName(shelf.shelfId);
      const measure = document.createElement("small"); measure.textContent = `${shelf.width.toFixed(1)} × ${shelf.depth.toFixed(1)}m`;
      const access = document.createElement("i"); access.className = `shelf-access is-${shelf.accessSide}`;
      const resize = document.createElement("i"); resize.className = "shelf-resize";
      element.append(label, measure, access, resize);
      element.addEventListener("pointerdown", (event) => beginObjectDrag(event, "shelf", shelf.id));
      resize.addEventListener("pointerdown", (event) => beginShelfResize(event, shelf.id));
      layer.append(element);
    }
    for (const marker of editor.map.markers) {
      const element = document.createElement("button");
      element.type = "button";
      element.className = `map-marker-object${editor.selected?.type === "marker" && editor.selected.id === marker.id ? " is-selected" : ""}`;
      element.style.left = `${marker.x / editor.map.width * 100}%`;
      element.style.top = `${marker.y / editor.map.depth * 100}%`;
      element.setAttribute("aria-label", `${marker.label}。ドラッグして移動`);
      const glyph = document.createElement("i"); glyph.className = "marker-glyph";
      const arrow = document.createElement("i"); arrow.className = "marker-direction"; arrow.style.transform = `rotate(${marker.rotation}deg)`;
      const label = document.createElement("span"); label.textContent = marker.label;
      element.append(glyph, arrow, label);
      element.addEventListener("pointerdown", (event) => beginObjectDrag(event, "marker", marker.id));
      layer.append(element);
    }
  }

  function select(type, id) {
    editor.selected = { type, id };
    editor.routePoints = [];
    render();
  }

  function beginObjectDrag(event, type, id) {
    if (byId("drawMapPath").getAttribute("aria-pressed") === "true") return;
    event.preventDefault(); event.stopPropagation();
    select(type, id);
    const item = objectBySelection();
    const start = stagePoint(event);
    const origin = { x: item.x, y: item.y };
    pushHistory();
    const move = (moveEvent) => {
      const point = stagePoint(moveEvent);
      item.x = snap(clamp(origin.x + point.x - start.x, 0, editor.map.width));
      item.y = snap(clamp(origin.y + point.y - start.y, 0, editor.map.depth));
      renderPaths(); renderObjects();
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      render();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  }

  function beginShelfResize(event, id) {
    event.preventDefault(); event.stopPropagation();
    select("shelf", id);
    const shelf = objectBySelection();
    const start = stagePoint(event);
    const original = { width: shelf.width, depth: shelf.depth };
    pushHistory();
    const move = (moveEvent) => {
      const point = stagePoint(moveEvent);
      shelf.width = snap(clamp(original.width + (point.x - start.x) * 2, 0.5, editor.map.width));
      shelf.depth = snap(clamp(original.depth + (point.y - start.y) * 2, 0.5, editor.map.depth));
      renderObjects();
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      render();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  }

  function renderInspector() {
    const selected = objectBySelection();
    byId("mapInspectorEmpty").classList.toggle("is-hidden", Boolean(selected));
    for (const id of ["mapShelfInspector", "mapMarkerInspector", "mapPathInspector"])
      byId(id).classList.add("is-hidden");
    if (!selected) return;
    if (editor.selected.type === "shelf") {
      const form = byId("mapShelfInspector"); form.classList.remove("is-hidden");
      const select = form.elements.shelfId; select.replaceChildren();
      for (const shelf of editor.shelves) select.add(new Option(shelf.name, shelf.id));
      select.value = selected.shelfId;
      form.querySelectorAll("[data-side]").forEach((button) =>
        button.classList.toggle("is-active", button.dataset.side === selected.accessSide));
    } else if (editor.selected.type === "marker") {
      const form = byId("mapMarkerInspector"); form.classList.remove("is-hidden");
      form.elements.label.value = selected.label;
      form.elements.markerId.value = selected.markerId;
    } else {
      const form = byId("mapPathInspector"); form.classList.remove("is-hidden");
      const first = selected.points[0]; const last = selected.points[selected.points.length - 1];
      const dx = last.x - first.x; const dy = last.y - first.y;
      form.elements.pathLength.value = Math.hypot(dx, dy).toFixed(2);
      form.elements.pathAngle.value = (Math.atan2(dy, dx) * 180 / Math.PI).toFixed(0);
    }
  }

  function renderSelectors() {
    const source = byId("mapShelfSource");
    const currentSource = source.value;
    source.replaceChildren();
    const placed = new Set(editor.map.shelves.map((item) => item.shelfId));
    const available = editor.shelves.filter((item) => !placed.has(item.id));
    if (available.length === 0) source.add(new Option("新しい棚を作成", "__new__"));
    else for (const shelf of available) source.add(new Option(shelf.name, shelf.id));
    if ([...source.options].some((option) => option.value === currentSource)) source.value = currentSource;
    byId("addMapShelf").disabled = false;

    const markerSelect = byId("routeStartMarker");
    const markerValue = markerSelect.value;
    markerSelect.replaceChildren(new Option("現在地QRを選択", ""));
    for (const marker of editor.map.markers) markerSelect.add(new Option(marker.label, marker.markerId));
    markerSelect.value = markerValue;
    const productSelect = byId("routeTargetProduct");
    const productValue = productSelect.value;
    productSelect.replaceChildren(new Option("商品を選択", ""));
    for (const product of editor.products.filter((item) => item.shelfId))
      productSelect.add(new Option(`${product.name}（${shelfName(product.shelfId)}）`, product.id));
    productSelect.value = productValue;
  }

  function nextShelfIdentity() {
    const used = new Set(editor.shelves.map((item) => item.id));
    let number = 1;
    while (used.has(`SHELF-A${String(number).padStart(2, "0")}`)) number += 1;
    return { id: `SHELF-A${String(number).padStart(2, "0")}`, name: `棚 A-${String(number).padStart(2, "0")}` };
  }

  async function addShelf() {
    const button = byId("addMapShelf");
    let shelfId = byId("mapShelfSource").value;
    if (!shelfId) return notify("棚を選択", true);
    if (shelfId === "__new__") {
      const identity = nextShelfIdentity();
      button.disabled = true; button.textContent = "棚を作成中…";
      try {
        const created = await api("/api/shelves", {
          method: "POST",
          body: JSON.stringify({ ...identity, zone: "", markerId: "", x: 0, y: 0, z: 0 }),
        });
        editor.shelves.push(created); shelfId = created.id;
        notify(`${created.name}を作成`);
      } catch (error) {
        notify(error.message, true); return;
      } finally {
        button.disabled = false;
        button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v10H4zM8 7V4m8 3V4M8 17v3m8-3v3"></path></svg>棚を置く';
      }
    }
    pushHistory();
    const number = editor.map.shelves.length;
    const shelf = { id: shelfId, shelfId, x: snap(editor.map.width * (0.35 + number % 3 * 0.15)),
      y: snap(editor.map.depth * (0.35 + Math.floor(number / 3) * 0.16)),
      width: 3, depth: 1.2, rotation: 0, accessSide: "bottom" };
    editor.map.shelves.push(shelf); select("shelf", shelf.id);
  }

  function addMarker() {
    const used = new Set(editor.map.markers.map((item) => item.markerId));
    const preferred = editor.shelves.map((item) => item.markerId).filter(Boolean).find((id) => !used.has(id));
    let index = editor.map.markers.length + 1;
    let markerId = preferred || `MARKER-${String(index).padStart(2, "0")}`;
    while (used.has(markerId)) markerId = `MARKER-${String(++index).padStart(2, "0")}`;
    pushHistory();
    const marker = { id: markerId, markerId, label: `現在地 ${index}`, x: snap(editor.map.width / 2),
      y: snap(editor.map.depth / 2), rotation: 0 };
    editor.map.markers.push(marker); select("marker", marker.id);
  }

  function toggleDrawMode() {
    const button = byId("drawMapPath");
    const active = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("is-active", active);
    byId("storeMapStage").classList.toggle("is-drawing", active);
    byId("mapStageHelp").textContent = active
      ? (requestedPathLength() == null
        ? "始点から終点までドラッグ。交差した線は自動接続"
        : `${requestedPathLength()}mの通路：始点から方向を決めてドラッグ`)
      : "棚・QRを配置。通路はドラッグで作成";
    editor.selected = null; renderInspector();
  }

  function toggleMeasurements() {
    editor.measurements = !editor.measurements;
    localStorage.setItem("intelligenti-map-measurements", editor.measurements ? "visible" : "hidden");
    const button = byId("toggleMapMeasures");
    button.setAttribute("aria-pressed", String(editor.measurements));
    button.textContent = editor.measurements ? "寸法を隠す" : "寸法を表示";
    byId("storeMapStage").classList.toggle("measurements-hidden", !editor.measurements);
  }

  function requestedPathLength() {
    const value = Number(byId("mapPathLength").value);
    return Number.isFinite(value) && value >= 0.25 ? value : null;
  }

  function constrainedPathEnd(start, rawEnd) {
    const length = requestedPathLength();
    if (length == null) return rawEnd;
    const dx = rawEnd.x - start.x; const dy = rawEnd.y - start.y;
    const magnitude = Math.hypot(dx, dy);
    if (magnitude < 0.01) return start;
    return { x: start.x + dx / magnitude * length, y: start.y + dy / magnitude * length };
  }

  function beginPath(event) {
    if (byId("drawMapPath").getAttribute("aria-pressed") !== "true" || event.button !== 0) return;
    event.preventDefault();
    editor.drawing = true; editor.drawStart = stagePoint(event); editor.previewEnd = editor.drawStart;
    const move = (moveEvent) => { editor.previewEnd = constrainedPathEnd(editor.drawStart, stagePoint(moveEvent)); renderPaths(); };
    const finish = (upEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      const end = constrainedPathEnd(editor.drawStart, stagePoint(upEvent));
      const outside = end.x < 0 || end.x > editor.map.width || end.y < 0 || end.y > editor.map.depth;
      if (outside) notify("マップ範囲外。始点または方向を調整", true);
      else if (Math.hypot(end.x - editor.drawStart.x, end.y - editor.drawStart.y) >= 0.25) {
        pushHistory();
        const path = { id: `PATH-${Date.now().toString(36).toUpperCase()}`, points: [editor.drawStart,
          { x: Number(end.x.toFixed(3)), y: Number(end.y.toFixed(3)) }] };
        editor.map.paths.push(path); editor.selected = { type: "path", id: path.id };
      }
      editor.drawing = false; editor.drawStart = null; editor.previewEnd = null; render();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  }

  function beginPathDrag(event, id) {
    if (byId("drawMapPath").getAttribute("aria-pressed") === "true" || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    byId("storeMapStage").focus();
    select("path", id);
    const path = objectBySelection();
    const start = stagePoint(event); const original = clone(path.points);
    let moved = false;
    const move = (moveEvent) => {
      const point = stagePoint(moveEvent);
      let dx = point.x - start.x; let dy = point.y - start.y;
      if (!moved && Math.hypot(dx, dy) < 0.1) return;
      if (!moved) { pushHistory(); moved = true; }
      const minX = Math.min(...original.map((item) => item.x)); const maxX = Math.max(...original.map((item) => item.x));
      const minY = Math.min(...original.map((item) => item.y)); const maxY = Math.max(...original.map((item) => item.y));
      dx = clamp(dx, -minX, editor.map.width - maxX); dy = clamp(dy, -minY, editor.map.depth - maxY);
      path.points = original.map((item) => ({ x: snap(item.x + dx), y: snap(item.y + dy) }));
      editor.routePoints = []; renderPaths();
    };
    const finish = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish);
      render();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  }

  function beginPathEndpointDrag(event, id, pointIndex) {
    if (byId("drawMapPath").getAttribute("aria-pressed") === "true" || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); byId("storeMapStage").focus();
    select("path", id);
    const path = objectBySelection();
    const anchorIndex = pointIndex === 0 ? path.points.length - 1 : 0;
    const anchor = clone(path.points[anchorIndex]);
    const original = clone(path.points[pointIndex]);
    let moved = false;
    const move = (moveEvent) => {
      let point = stagePoint(moveEvent);
      if (moveEvent.shiftKey) {
        const dx = point.x - anchor.x; const dy = point.y - anchor.y;
        const length = Math.hypot(dx, dy);
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        point = { x: snap(clamp(anchor.x + Math.cos(angle) * length, 0, editor.map.width)),
          y: snap(clamp(anchor.y + Math.sin(angle) * length, 0, editor.map.depth)) };
      }
      if (!moved && Math.hypot(point.x - original.x, point.y - original.y) < 0.1) return;
      if (!moved) { pushHistory(); moved = true; }
      path.points[pointIndex] = point; editor.routePoints = []; renderPaths();
    };
    const finish = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish);
      render();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  }

  function setSelectedPathMetric(metric, rawValue) {
    const path = objectBySelection();
    if (editor.selected?.type !== "path" || !path || path.points.length < 2) return;
    const first = path.points[0]; const lastIndex = path.points.length - 1; const last = path.points[lastIndex];
    const currentLength = Math.hypot(last.x - first.x, last.y - first.y);
    let length = currentLength; let angle = Math.atan2(last.y - first.y, last.x - first.x);
    if (metric === "length") length = Number(rawValue);
    else angle = Number(rawValue) * Math.PI / 180;
    if (!Number.isFinite(length) || length < 0.25 || !Number.isFinite(angle)) return notify("長さまたは角度が不正", true);
    const next = { x: first.x + Math.cos(angle) * length, y: first.y + Math.sin(angle) * length };
    if (next.x < 0 || next.x > editor.map.width || next.y < 0 || next.y > editor.map.depth)
      return notify("マップ範囲外。長さまたは角度を調整", true);
    pushHistory(); path.points[lastIndex] = { x: Number(next.x.toFixed(3)), y: Number(next.y.toFixed(3)) };
    editor.routePoints = []; render();
  }

  function removeSelected(expectedType) {
    if (editor.selected?.type !== expectedType) return;
    pushHistory();
    const key = expectedType === "shelf" ? "shelves" : expectedType === "marker" ? "markers" : "paths";
    editor.map[key] = editor.map[key].filter((item) => item.id !== editor.selected.id);
    editor.selected = null; editor.routePoints = []; render();
  }

  function undo() {
    if (!editor.undo.length) return;
    editor.redo.push(clone(editor.map)); editor.map = editor.undo.pop(); editor.selected = null; markDirty(); render();
  }

  function redo() {
    if (!editor.redo.length) return;
    editor.undo.push(clone(editor.map)); editor.map = editor.redo.pop(); editor.selected = null; markDirty(); render();
  }

  async function save() {
    const button = byId("saveStoreMap"); button.disabled = true; button.textContent = "保存中…";
    try {
      const saved = await api("/api/store-map", { method: "PUT", body: JSON.stringify(editor.map) });
      editor.map = saved.layout; markSaved(saved.updatedAt); notify("店舗マップを保存"); render();
      return true;
    } catch (error) { notify(error.message, true); return false; }
    finally { button.disabled = false; button.textContent = "マップを保存"; }
  }

  async function previewRoute() {
    const fromMarkerId = byId("routeStartMarker").value;
    const toProductId = byId("routeTargetProduct").value;
    const result = byId("routePreviewResult");
    if (!fromMarkerId || !toProductId) { result.textContent = "現在地と商品を選択"; return; }
    if (editor.dirty && !(await save())) return;
    result.textContent = "経路を計算中…";
    try {
      const route = await api("/api/navigation/route", {
        method: "POST", body: JSON.stringify({ fromMarkerId, toProductId }),
      });
      editor.routePoints = route.points;
      result.textContent = `案内可能：約${route.distanceMeters}m`;
      renderPaths();
    } catch (error) {
      editor.routePoints = []; renderPaths(); result.textContent = error.message; notify(error.message, true);
    }
  }

  function printSelectedMarker() {
    const marker = objectBySelection();
    if (!marker || !/^[A-Z0-9_-]{1,64}$/.test(marker.markerId)) return notify("QR IDが不正", true);
    const popup = window.open(`/api/markers/${encodeURIComponent(marker.markerId)}/image.svg`, "_blank");
    if (!popup) notify("ポップアップ許可が必要", true);
  }

  function bind() {
    byId("addMapShelf").addEventListener("click", () => void addShelf());
    byId("addMapMarker").addEventListener("click", addMarker);
    byId("drawMapPath").addEventListener("click", toggleDrawMode);
    byId("toggleMapMeasures").addEventListener("click", toggleMeasurements);
    byId("mapPathLength").addEventListener("input", () => {
      if (byId("drawMapPath").getAttribute("aria-pressed") !== "true") return;
      const length = requestedPathLength();
      byId("mapStageHelp").textContent = length == null
        ? "始点から終点までドラッグ。交差した線は自動接続"
        : `${length}mの通路：始点から方向を決めてドラッグ`;
    });
    byId("storeMapStage").addEventListener("pointerdown", beginPath);
    byId("storeMapStage").addEventListener("click", (event) => {
      if (event.target === byId("storeMapStage") || event.target === byId("mapObjectLayer")) {
        editor.selected = null; render();
      }
    });
    byId("mapUndo").addEventListener("click", undo);
    byId("mapRedo").addEventListener("click", redo);
    byId("saveStoreMap").addEventListener("click", save);
    byId("previewRoute").addEventListener("click", previewRoute);
    byId("deleteMapShelf").addEventListener("click", () => removeSelected("shelf"));
    byId("deleteMapMarker").addEventListener("click", () => removeSelected("marker"));
    byId("deleteMapPath").addEventListener("click", () => removeSelected("path"));
    const pathForm = byId("mapPathInspector");
    pathForm.elements.pathLength.addEventListener("change", (event) => setSelectedPathMetric("length", event.target.value));
    pathForm.elements.pathAngle.addEventListener("change", (event) => setSelectedPathMetric("angle", event.target.value));
    byId("rotateMapShelf").addEventListener("click", () => {
      const shelf = objectBySelection(); if (!shelf) return; pushHistory(); shelf.rotation = (shelf.rotation + 90) % 360; render();
    });
    byId("rotateMapMarker").addEventListener("click", () => {
      const marker = objectBySelection(); if (!marker) return; pushHistory(); marker.rotation = (marker.rotation + 90) % 360; render();
    });
    byId("printMapMarker").addEventListener("click", printSelectedMarker);
    byId("mapShelfInspector").elements.shelfId.addEventListener("change", (event) => {
      const shelf = objectBySelection(); if (!shelf) return; pushHistory(); shelf.shelfId = event.target.value; shelf.id = shelf.shelfId; editor.selected.id = shelf.id; render();
    });
    byId("mapShelfInspector").querySelectorAll("[data-side]").forEach((button) => button.addEventListener("click", () => {
      const shelf = objectBySelection(); if (!shelf) return; pushHistory(); shelf.accessSide = button.dataset.side; render();
    }));
    byId("mapShelfInspector").querySelectorAll("[data-resize]").forEach((button) => button.addEventListener("click", () => {
      const shelf = objectBySelection(); if (!shelf) return; pushHistory();
      if (button.dataset.resize === "smaller") { shelf.width = Math.max(0.5, shelf.width - 0.5); shelf.depth = Math.max(0.5, shelf.depth - 0.25); }
      if (button.dataset.resize === "wider") shelf.width = Math.min(editor.map.width, shelf.width + 0.5);
      if (button.dataset.resize === "deeper") shelf.depth = Math.min(editor.map.depth, shelf.depth + 0.25);
      render();
    }));
    const markerForm = byId("mapMarkerInspector");
    markerForm.elements.label.addEventListener("change", (event) => {
      const marker = objectBySelection(); if (!marker) return; pushHistory(); marker.label = event.target.value.trim() || marker.markerId; render();
    });
    markerForm.elements.markerId.addEventListener("change", (event) => {
      const marker = objectBySelection(); const value = event.target.value.trim().toUpperCase();
      if (!marker || !/^[A-Z0-9_-]{1,64}$/.test(value)) return notify("QR IDは英数字・ハイフンのみ", true);
      if (editor.map.markers.some((item) => item !== marker && item.markerId === value)) return notify("同じQR IDがすでにあります", true);
      pushHistory(); marker.markerId = value; marker.id = value; editor.selected.id = marker.id; render();
    });
    for (const id of ["mapWidth", "mapDepth"]) byId(id).addEventListener("change", () => {
      pushHistory(); editor.map.width = clamp(Number(byId("mapWidth").value) || 24, 4, 200);
      editor.map.depth = clamp(Number(byId("mapDepth").value) || 16, 4, 200);
      for (const item of [...editor.map.shelves, ...editor.map.markers]) {
        item.x = clamp(item.x, 0, editor.map.width); item.y = clamp(item.y, 0, editor.map.depth);
      }
      render();
    });
    byId("storeMapStage").addEventListener("keydown", (event) => {
      const item = objectBySelection();
      if (!item || !["shelf", "marker", "path"].includes(editor.selected.type) || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Delete", "Backspace"].includes(event.key)) return;
      event.preventDefault();
      if (["Delete", "Backspace"].includes(event.key)) return removeSelected(editor.selected.type);
      pushHistory(); const amount = event.shiftKey ? 1 : 0.25;
      if (editor.selected.type === "path") {
        const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
        const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
        const canMove = item.points.every((point) => point.x + dx >= 0 && point.x + dx <= editor.map.width && point.y + dy >= 0 && point.y + dy <= editor.map.depth);
        if (canMove) item.points = item.points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
      } else {
        if (event.key === "ArrowLeft") item.x = clamp(item.x - amount, 0, editor.map.width);
        if (event.key === "ArrowRight") item.x = clamp(item.x + amount, 0, editor.map.width);
        if (event.key === "ArrowUp") item.y = clamp(item.y - amount, 0, editor.map.depth);
        if (event.key === "ArrowDown") item.y = clamp(item.y + amount, 0, editor.map.depth);
      }
      render();
    });
    window.addEventListener("beforeunload", (event) => {
      if (!editor.dirty) return; event.preventDefault(); event.returnValue = "";
    });
  }

  async function refreshCatalog() {
    const [shelves, products] = await Promise.all([
      api("/api/shelves"), api("/api/products?limit=100"),
    ]);
    editor.shelves = shelves;
    editor.products = products;
    if (editor.map) render();
  }

  async function load() {
    if (editor.loading) return;
    editor.loading = true;
    try {
      if (editor.loaded) {
        await refreshCatalog();
      } else {
        const [map, shelves, products] = await Promise.all([
          api("/api/store-map"), api("/api/shelves"), api("/api/products?limit=100"),
        ]);
        editor.map = map.layout; editor.shelves = shelves; editor.products = products;
        editor.loaded = true; markSaved(map.updatedAt); render();
      }
    } catch (error) { byId("mapSaveState").textContent = error.message; notify(error.message, true); }
    finally { editor.loading = false; }
  }

  bind();
  window.IntelligentiMapEditor = { open: load, refreshCatalog };
})();
