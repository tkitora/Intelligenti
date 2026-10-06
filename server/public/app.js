const state = {
  products: [],
  shelves: [],
  editingProductId: null,
  editingShelfId: null,
  searchTimer: null,
  productImage: {
    file: null,
    previewUrl: null,
  },
  reader: {
    device: null,
    commandCharacteristic: null,
    statusCharacteristic: null,
    connecting: false,
    writingProductId: null,
    cancellingWrite: false,
  },
};

const BLE_SERVICE_UUID = "9d880100-504a-4c45-4e54-454c4c494745";
const BLE_COMMAND_UUID = "9d880101-504a-4c45-4e54-454c4c494745";
const BLE_STATUS_UUID = "9d880102-504a-4c45-4e54-454c4c494745";
const MAX_TAG_PRODUCT_ID_LENGTH = 13;
const MAX_PRODUCT_IMAGE_BYTES = 6 * 1024 * 1024;
const PRODUCT_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const $ = (selector) => document.querySelector(selector);
const loginView = $("#loginView");
const appView = $("#appView");
const productDialog = $("#productDialog");
const productForm = $("#productForm");
const readerSettingsDialog = $("#readerSettingsDialog");

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || `通信エラー (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function clearProductImagePreviewUrl() {
  if (state.productImage.previewUrl) URL.revokeObjectURL(state.productImage.previewUrl);
  state.productImage.previewUrl = null;
}

function setProductImageStatus(message, tone = "") {
  const status = $("#productImageStatus");
  status.textContent = message;
  status.className = `product-image-status${tone ? ` ${tone}` : ""}`;
}

function renderProductImage(imageUrl = "", alt = "") {
  const image = $("#productImagePreviewImage");
  const placeholder = $("#productImagePlaceholder");
  image.classList.toggle("is-visible", Boolean(imageUrl));
  placeholder.classList.toggle("is-hidden", Boolean(imageUrl));
  image.src = imageUrl;
  image.alt = imageUrl ? alt : "";
  $("#removeProductImage").classList.toggle("is-hidden", !imageUrl);
}

function resetProductImage(imageUrl = "") {
  clearProductImagePreviewUrl();
  state.productImage.file = null;
  $("#productImageInput").value = "";
  productForm.elements.imageUrl.value = imageUrl;
  renderProductImage(imageUrl, imageUrl ? "現在の商品画像" : "");
  setProductImageStatus("JPEG・PNG・WebP / 6MBまで");
}

function selectProductImage(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!PRODUCT_IMAGE_TYPES.has(file.type)) {
    event.target.value = "";
    setProductImageStatus("JPEG・PNG・WebP形式の画像を選択してください", "error");
    return;
  }
  if (file.size > MAX_PRODUCT_IMAGE_BYTES) {
    event.target.value = "";
    setProductImageStatus("画像は6MB以内にしてください", "error");
    return;
  }
  clearProductImagePreviewUrl();
  state.productImage.file = file;
  state.productImage.previewUrl = URL.createObjectURL(file);
  renderProductImage(state.productImage.previewUrl, "選択した商品画像");
  setProductImageStatus(`${file.name} / ${(file.size / 1024 / 1024).toFixed(1)}MB`, "success");
}

function removeProductImage() {
  clearProductImagePreviewUrl();
  state.productImage.file = null;
  $("#productImageInput").value = "";
  productForm.elements.imageUrl.value = "";
  renderProductImage();
  setProductImageStatus("画像を削除して保存します");
}

async function prepareProductImage(file) {
  if (file.type !== "image/webp") {
    return { bytes: await file.arrayBuffer(), contentType: file.type };
  }

  const sourceUrl = URL.createObjectURL(file);
  try {
    const sourceImage = new Image();
    sourceImage.decoding = "async";
    await new Promise((resolve, reject) => {
      sourceImage.onload = resolve;
      sourceImage.onerror = () => reject(new Error("画像を変換できません。JPEGまたはPNGを選択してください"));
      sourceImage.src = sourceUrl;
    });
    const maximumSide = 1600;
    const scale = Math.min(1, maximumSide / Math.max(sourceImage.naturalWidth, sourceImage.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceImage.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceImage.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("画像を変換できません。JPEGまたはPNGを選択してください");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!jpeg) throw new Error("画像を変換できません。JPEGまたはPNGを選択してください");
    return { bytes: await jpeg.arrayBuffer(), contentType: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

async function uploadProductImage(file) {
  const preparedImage = await prepareProductImage(file);
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch("/api/product-images", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": preparedImage.contentType },
        body: preparedImage.bytes,
      });
      break;
    } catch (error) {
      if (attempt === 1) throw new Error("画像を送信できません。通信を確認して、もう一度保存してください");
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }
  const data = await response.json().catch(() => null);
  if (response.status === 401) throw new Error("ログインの有効期限が切れました。画面を再読み込みしてください");
  if (!response.ok) throw new Error(data?.error || `画像アップロード失敗 (${response.status})`);
  return data.imageUrl;
}

function readerConnected() {
  return Boolean(
    state.reader.device?.gatt?.connected && state.reader.commandCharacteristic,
  );
}

function setTagWriterStatus(message, tone = "") {
  const status = $("#tagWriterStatus");
  status.textContent = message;
  status.className = tone;
}

function renderTagWriteState() {
  const writing = Boolean(state.reader.writingProductId);
  const writeButton = $("#writeTagButton");
  const cancelButton = $("#cancelTagWriteButton");
  writeButton.disabled = writing;
  writeButton.textContent = writing
    ? "タグをかざす"
    : readerConnected()
      ? "NFCタグへ書き込む"
      : "接続してタグへ書き込む";
  cancelButton.classList.toggle("is-hidden", !writing);
  cancelButton.disabled = state.reader.cancellingWrite;
  cancelButton.textContent = state.reader.cancellingWrite ? "キャンセル中…" : "書込みをキャンセル";

  const lockedSelectors = ["#closeDialog", "#deleteProductButton", "#guideProductButton", '#productForm button[type="submit"]'];
  for (const selector of lockedSelectors) {
    const control = $(selector);
    if (control) control.disabled = writing;
  }
}

function finishTagWrite() {
  state.reader.writingProductId = null;
  state.reader.cancellingWrite = false;
  renderTagWriteState();
}

function renderReaderState() {
  const connected = readerConnected();
  const button = $("#readerConnectButton");
  button.classList.toggle("is-connected", connected);
  button.classList.toggle("is-connecting", state.reader.connecting);
  button.disabled = state.reader.connecting;
  $("#readerConnectText").textContent = state.reader.connecting
    ? "接続中…"
    : connected
      ? state.reader.device.name || "NFCリーダー接続済み"
      : "NFCリーダーへ接続";

  renderTagWriteState();
}

function bluetoothErrorMessage(error) {
  if (error?.name === "NotFoundError") return "リーダー選択をキャンセル";
  if (error?.name === "SecurityError") return "BluetoothはHTTPS版Chromeのみ対応";
  return error?.message || "NFCリーダー接続失敗";
}

async function sendReaderCommand(payload) {
  const characteristic = state.reader.commandCharacteristic;
  if (!readerConnected() || !characteristic) throw new Error("NFCリーダー未接続");
  const value = new TextEncoder().encode(JSON.stringify(payload));
  if (characteristic.properties.writeWithoutResponse && characteristic.writeValueWithoutResponse) {
    await characteristic.writeValueWithoutResponse(value);
  } else if (characteristic.writeValueWithResponse) {
    await characteristic.writeValueWithResponse(value);
  } else {
    await characteristic.writeValue(value);
  }
}

function handleReaderStatus(event) {
  try {
    const raw = new TextDecoder().decode(event.target.value);
    const status = JSON.parse(raw);

    if (status.event === "config" && status.message === "saved") {
      $("#readerSetupStatus").textContent = "設定保存済み。Wi-Fi接続中…";
      return;
    }
    if (status.event === "wifi") {
      const connected = status.message === "connected";
      $("#readerSetupStatus").textContent = connected
        ? "接続完了。NFC読取り結果をサーバーへ送信可能。"
        : "Wi-Fi接続失敗。SSID・パスワード・2.4GHz設定を確認。";
      $("#readerSetupStatus").className = `reader-setup-status full-span ${connected ? "success" : "error"}`;
      $("#readerSettingsForm").setAttribute("aria-busy", "false");
      $("#saveReaderSettings").disabled = false;
      if (connected) showToast("NFCリーダーのWi-Fi接続完了");
      return;
    }

    if (status.event === "mode" && status.message === "write_waiting") {
      state.reader.writingProductId = status.productId || state.editingProductId;
      state.reader.cancellingWrite = false;
      renderTagWriteState();
      setTagWriterStatus(`書込待機：${status.productId} のタグをかざす`, "waiting");
      return;
    }
    if (status.event === "mode" && status.message === "read" && state.reader.writingProductId) {
      finishTagWrite();
      setTagWriterStatus("書込みキャンセル", "");
      return;
    }
    if (status.event === "write" && status.message === "success") {
      finishTagWrite();
      setTagWriterStatus(`書込み完了：${status.productId}`, "success");
      showToast(`${status.productId} のタグ書込み完了`);
      return;
    }
    if (status.event === "write" && status.message === "failed") {
      const message = "タグ書込み失敗";
      sendReaderCommand({ cmd: "stop" }).catch(() => null);
      finishTagWrite();
      setTagWriterStatus(message, "error");
      showToast(message, true);
      return;
    }
    if (status.event === "error") {
      const messages = {
        invalid_product_id: "商品IDをタグへ保存不可",
        tag_authentication_failed: "タグ認証失敗。対応タグを確認",
        tag_write_failed: "タグ書込み失敗",
      };
      const message = messages[status.message] || `リーダーエラー：${status.message || "unknown"}`;
      if (state.reader.writingProductId) {
        sendReaderCommand({ cmd: "stop" }).catch(() => null);
        finishTagWrite();
      }
      setTagWriterStatus(message, "error");
      showToast(message, true);
      return;
    }
    if (status.event === "status") {
      setTagWriterStatus(
        status.message === "write_waiting"
          ? `書込待機：${status.productId} のタグをかざす`
          : "リーダー接続済み。商品を選んでタグへ書込み。",
        status.message === "write_waiting" ? "waiting" : "success",
      );
    }
  } catch {
    setTagWriterStatus("リーダーから不明な応答", "error");
  }
}

function openReaderSettings() {
  $("#readerSetupStatus").textContent = readerConnected()
    ? `${state.reader.device.name} へWi-Fi設定を送信可能。`
    : "保存時にNFCリーダーを選択。";
  $("#readerSetupStatus").className = "reader-setup-status full-span";
  readerSettingsDialog.showModal();
  readerSettingsDialog.querySelector('[name="ssid"]').focus();
}

async function saveReaderSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = $("#saveReaderSettings");
  button.disabled = true;
  form.setAttribute("aria-busy", "true");
  $("#readerSetupStatus").textContent = "リーダー接続中…";
  try {
    if (!(await connectReader())) throw new Error("NFCリーダー接続失敗");
    const provisioning = await request("/api/reader-provisioning");
    const fields = new FormData(form);
    await sendReaderCommand({
      cmd: "configure",
      ssid: String(fields.get("ssid") || "").trim(),
      wifiPassword: String(fields.get("wifiPassword") || ""),
      apiBaseUrl: provisioning.apiBaseUrl,
      apiKey: provisioning.apiKey,
    });
    $("#readerSetupStatus").textContent = "設定送信済み。接続確認中…";
  } catch (error) {
    $("#readerSetupStatus").textContent = error.message || "設定保存失敗";
    $("#readerSetupStatus").className = "reader-setup-status full-span error";
    button.disabled = false;
    form.setAttribute("aria-busy", "false");
    showToast(error.message || "設定保存失敗", true);
  }
}

function handleReaderDisconnected() {
  state.reader.commandCharacteristic = null;
  state.reader.statusCharacteristic = null;
  finishTagWrite();
  renderReaderState();
  setTagWriterStatus("リーダー接続切断。再接続が必要。", "error");
  showToast("NFCリーダー接続切断", true);
}

async function connectReader() {
  if (readerConnected()) return true;
  if (!navigator.bluetooth) {
    const message = "Web Bluetooth対応Chromeが必要";
    setTagWriterStatus(message, "error");
    showToast(message, true);
    return false;
  }

  state.reader.connecting = true;
  renderReaderState();
  setTagWriterStatus("近くのIntelligentiリーダーを検索中…", "waiting");
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "Intelligenti-" }],
      optionalServices: [BLE_SERVICE_UUID],
    });
    device.addEventListener("gattserverdisconnected", handleReaderDisconnected);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE_UUID);
    const [commandCharacteristic, statusCharacteristic] = await Promise.all([
      service.getCharacteristic(BLE_COMMAND_UUID),
      service.getCharacteristic(BLE_STATUS_UUID),
    ]);
    await statusCharacteristic.startNotifications();
    statusCharacteristic.addEventListener("characteristicvaluechanged", handleReaderStatus);

    state.reader.device = device;
    state.reader.commandCharacteristic = commandCharacteristic;
    state.reader.statusCharacteristic = statusCharacteristic;
    setTagWriterStatus(`${device.name || "NFCリーダー"} 接続済み`, "success");
    showToast(`${device.name || "NFCリーダー"} 接続完了`);
    await sendReaderCommand({ cmd: "status" });
    return true;
  } catch (error) {
    const message = bluetoothErrorMessage(error);
    setTagWriterStatus(message, "error");
    showToast(message, true);
    return false;
  } finally {
    state.reader.connecting = false;
    renderReaderState();
  }
}

async function writeProductTag() {
  const productId = state.editingProductId;
  if (!productId) return;
  if (productId.length > MAX_TAG_PRODUCT_ID_LENGTH) {
    const message = `商品IDはタグ書込み用に${MAX_TAG_PRODUCT_ID_LENGTH}文字以内`;
    setTagWriterStatus(message, "error");
    showToast(message, true);
    return;
  }

  state.reader.writingProductId = productId;
  renderTagWriteState();
  try {
    if (!(await connectReader())) {
      finishTagWrite();
      return;
    }
    await sendReaderCommand({ cmd: "write", productId });
    setTagWriterStatus(`${productId} の書込準備中…`, "waiting");
    $("#cancelTagWriteButton").focus();
  } catch (error) {
    finishTagWrite();
    const message = bluetoothErrorMessage(error);
    setTagWriterStatus(message, "error");
    showToast(message, true);
  }
}

async function cancelProductTagWrite() {
  if (!state.reader.writingProductId || state.reader.cancellingWrite) return;
  state.reader.cancellingWrite = true;
  renderTagWriteState();
  try {
    await sendReaderCommand({ cmd: "stop" });
    finishTagWrite();
    setTagWriterStatus("書込みキャンセル", "");
    showToast("NFCタグ書込みキャンセル");
  } catch (error) {
    state.reader.cancellingWrite = false;
    renderTagWriteState();
    const message = bluetoothErrorMessage(error);
    setTagWriterStatus(message, "error");
    showToast(message, true);
  }
}

function showLogin() {
  appView.classList.add("is-hidden");
  loginView.classList.remove("is-hidden");
  $("#passwordInput").focus();
}

async function showApp() {
  loginView.classList.add("is-hidden");
  appView.classList.remove("is-hidden");
  await Promise.all([loadShelves(), loadProducts(), checkHealth()]);
}

async function checkHealth() {
  const dot = $("#serverDot");
  try {
    const health = await request("/health");
    const online = health.status === "ok" && health.database === "connected";
    dot.className = online ? "online" : "offline";
    $("#serverText").textContent = online ? "サーバー正常" : "一部未接続";
  } catch {
    dot.className = "offline";
    $("#serverText").textContent = "サーバー未接続";
  }
}

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function makeProductAvatar(product) {
  const initial = product.name.trim().slice(0, 1).toUpperCase() || "?";
  const avatar = make("div", "product-avatar", initial);

  if (!product.imageUrl) return avatar;

  const image = document.createElement("img");
  image.alt = `${product.name}の商品画像`;
  image.width = 36;
  image.height = 36;
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("load", () => avatar.classList.add("has-image"));
  image.addEventListener("error", () => image.remove());
  image.src = product.imageUrl;
  avatar.append(image);
  return avatar;
}

async function loadProducts(query = $("#searchInput").value.trim()) {
  try {
    state.products = await request(`/api/products?limit=100&q=${encodeURIComponent(query)}`);
    renderProducts();
  } catch (error) {
    if (error.status === 401) showLogin();
    else showToast(error.message, true);
  }
}

function renderProducts() {
  const body = $("#productRows");
  body.replaceChildren();

  for (const product of state.products) {
    const row = document.createElement("tr");

    const productColumn = document.createElement("td");
    const productCell = make("div", "product-cell");
    productCell.append(makeProductAvatar(product));
    const identity = make("div", "product-identity");
    const metadata = make("div", "product-metadata");
    metadata.append(make("small", "", product.id));
    if (product.tagLinked) {
      const tagBadge = make("span", "tag-linked-badge");
      tagBadge.setAttribute("aria-label", "NFCタグ紐付け済み");
      tagBadge.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.4 4.1 8 2.5a3.2 3.2 0 0 1 4.5 4.5l-2 2a3.2 3.2 0 0 1-4.5 0"/><path d="m9.6 11.9-1.6 1.6A3.2 3.2 0 0 1 3.5 9l2-2a3.2 3.2 0 0 1 4.5 0"/></svg><span>タグ済み</span>';
      metadata.append(tagBadge);
    }
    identity.append(make("strong", "", product.name), metadata);
    productCell.append(identity);
    productColumn.append(productCell);

    const price = make("td", "", product.price);
    const stock = document.createElement("td");
    stock.append(make("span", `stock-pill${product.stock <= 5 ? " low" : ""}`, String(product.stock)));
    const shelf = make("td", "", product.shelfId || "未配置");
    const status = document.createElement("td");
    status.append(make("span", "status-pill", product.shelfId ? "案内可能" : "要配置"));
    const action = document.createElement("td");
    const editButton = make("button", "row-action", "編集");
    editButton.type = "button";
    editButton.addEventListener("click", () => openProductDialog(product));
    action.append(editButton);
    row.append(productColumn, price, stock, shelf, status, action);
    const describeProduct = () => {
      $("#liveSelection").textContent = `${product.id} / ${product.shelfId || "未配置"} / 在庫 ${product.stock}`;
    };
    row.addEventListener("mouseenter", describeProduct);
    row.addEventListener("focusin", describeProduct);
    row.addEventListener("mouseleave", () => {
      $("#liveSelection").textContent = "商品にポイントして詳細表示";
    });
    body.append(row);
  }

  const empty = state.products.length === 0;
  $("#productEmpty").classList.toggle("is-hidden", !empty);
  $(".table-wrap").classList.toggle("is-hidden", empty);
  $("#resultCount").textContent = `${state.products.length}件`;
  $("#productCount").textContent = String(state.products.length);
  $("#stockCount").textContent = state.products.reduce((sum, product) => sum + product.stock, 0).toLocaleString("ja-JP");
}

async function loadShelves() {
  try {
    state.shelves = await request("/api/shelves");
    renderShelves();
    refreshShelfOptions();
    $("#shelfCount").textContent = String(state.shelves.length);
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderShelves() {
  const grid = $("#shelfGrid");
  grid.replaceChildren();
  for (const shelf of state.shelves) {
    const card = make("article", `shelf-card${state.editingShelfId === shelf.id ? " is-selected" : ""}`);
    const selectButton = make("button", "shelf-card-button");
    selectButton.type = "button";
    selectButton.setAttribute("aria-pressed", String(state.editingShelfId === shelf.id));
    selectButton.setAttribute("aria-label", `${shelf.name}を編集`);
    const header = document.createElement("header");
    header.append(make("strong", "", shelf.name), make("code", "", shelf.id));
    selectButton.append(
      header,
      make("p", "", `${shelf.zone || "ゾーン未設定"}\n商品 ${shelf.productCount}件`),
    );
    selectButton.addEventListener("click", () => selectShelf(shelf));
    card.append(selectButton);
    grid.append(card);
  }
  if (state.shelves.length === 0) grid.append(make("p", "empty-state", "売場未登録"));
}

function resetShelfForm() {
  state.editingShelfId = null;
  const form = $("#shelfForm");
  form.reset();
  form.elements.id.disabled = false;
  $("#shelfFormCode").textContent = "NEW AISLE";
  $("#shelfFormTitle").textContent = "売場を登録";
  $("#saveShelfButton").textContent = "売場を登録";
  $("#newShelfButton").classList.add("is-hidden");
  $("#assignmentStatus").textContent = "";
  renderShelves();
}

function selectShelf(shelf) {
  state.editingShelfId = shelf.id;
  const form = $("#shelfForm");
  form.elements.id.disabled = true;
  form.elements.id.value = shelf.id;
  form.elements.name.value = shelf.name;
  form.elements.zone.value = shelf.zone || "";
  $("#shelfFormCode").textContent = "AISLE ASSIGNMENT";
  $("#shelfFormTitle").textContent = "売場を編集";
  $("#saveShelfButton").textContent = "変更を保存";
  $("#newShelfButton").classList.remove("is-hidden");
  $("#assignmentStatus").textContent = `${shelf.name} を編集中`;
  renderShelves();
  if (window.matchMedia("(max-width: 1080px)").matches)
    form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function refreshShelfOptions(selected = "") {
  const select = productForm.elements.shelfId;
  select.replaceChildren(new Option("未配置", ""));
  for (const shelf of state.shelves) select.add(new Option(`${shelf.name} (${shelf.id})`, shelf.id));
  select.value = selected;
}

function openProductDialog(product = null) {
  state.editingProductId = product?.id || null;
  productForm.reset();
  $("#dialogTitle").textContent = product ? "商品を編集" : "商品を登録";
  const idInput = productForm.elements.id;
  idInput.disabled = Boolean(product);
  idInput.value = product?.id || "";
  productForm.elements.name.value = product?.name || "";
  productForm.elements.priceYen.value = product?.priceYen ?? "";
  productForm.elements.stock.value = product?.stock ?? 0;
  productForm.elements.offsetX.value = product?.shelfOffset?.x ?? 0;
  productForm.elements.offsetY.value = product?.shelfOffset?.y ?? 0;
  productForm.elements.offsetZ.value = product?.shelfOffset?.z ?? 0;
  productForm.elements.description.value = product?.description || "";
  resetProductImage(product?.imageUrl || "");
  refreshShelfOptions(product?.shelfId || "");
  $("#deleteProductButton").classList.toggle("is-hidden", !product);
  $("#guideProductButton").classList.toggle("is-hidden", !product);
  $("#writeTagButton").classList.toggle("is-hidden", !product);
  $("#tagWriterPanel").classList.toggle("is-hidden", !product);
  if (product) {
    setTagWriterStatus(
      product.id.length <= MAX_TAG_PRODUCT_ID_LENGTH
        ? `${product.id} をNFCタグへ書込み可能。`
        : `タグ書込み不可：商品IDは${MAX_TAG_PRODUCT_ID_LENGTH}文字以内`,
      product.id.length <= MAX_TAG_PRODUCT_ID_LENGTH ? "" : "error",
    );
  }
  renderReaderState();
  productDialog.showModal();
}

async function saveProduct(event) {
  event.preventDefault();
  if (!productForm.reportValidity()) return;
  const submit = productForm.querySelector('button[type="submit"]');
  const imageInput = $("#productImageInput");
  const removeImageButton = $("#removeProductImage");
  submit.disabled = true;
  imageInput.disabled = true;
  removeImageButton.disabled = true;
  productForm.setAttribute("aria-busy", "true");
  const payload = {
    id: state.editingProductId || productForm.elements.id.value.trim(),
    name: productForm.elements.name.value.trim(),
    priceYen: Number(productForm.elements.priceYen.value),
    stock: Number(productForm.elements.stock.value),
    shelfId: productForm.elements.shelfId.value,
    shelfOffset: {
      x: Number(productForm.elements.offsetX.value),
      y: Number(productForm.elements.offsetY.value),
      z: Number(productForm.elements.offsetZ.value),
    },
    description: productForm.elements.description.value.trim(),
    imageUrl: productForm.elements.imageUrl.value.trim(),
  };
  try {
    if (state.productImage.file) {
      submit.textContent = "画像を送信中…";
      setProductImageStatus("画像をアップロード中…");
      payload.imageUrl = await uploadProductImage(state.productImage.file);
      productForm.elements.imageUrl.value = payload.imageUrl;
    }
    submit.textContent = "保存中…";
    if (state.editingProductId) {
      await request(`/api/products/${encodeURIComponent(state.editingProductId)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      showToast("商品情報を更新");
    } else {
      await request("/api/products", { method: "POST", body: JSON.stringify(payload) });
      showToast("商品を登録");
    }
    productDialog.close();
    await loadProducts();
  } catch (error) {
    setProductImageStatus(error.message, "error");
    showToast(error.message, true);
  } finally {
    submit.disabled = false;
    imageInput.disabled = false;
    removeImageButton.disabled = false;
    submit.textContent = "保存";
    productForm.setAttribute("aria-busy", "false");
  }
}

async function deleteProduct() {
  if (!state.editingProductId) return;
  if (!confirm(`商品 ${state.editingProductId} を削除？`)) return;
  try {
    await request(`/api/products/${encodeURIComponent(state.editingProductId)}`, { method: "DELETE" });
    productDialog.close();
    showToast("商品を削除");
    await loadProducts();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function guideProduct() {
  if (!state.editingProductId) return;
  const button = $("#guideProductButton");
  button.disabled = true;
  try {
    await request("/api/goggles/BEAMPRO-01/target", {
      method: "POST",
      body: JSON.stringify({ productId: state.editingProductId }),
    });
    showToast("Beam Proへ商品案内を送信");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function saveShelf(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const payload = Object.fromEntries(data.entries());
  payload.id = state.editingShelfId || String(payload.id || "").trim();
  payload.markerId = "";
  payload.x = 0;
  payload.y = 0;
  payload.z = 0;
  const submit = $("#saveShelfButton");
  submit.disabled = true;
  form.setAttribute("aria-busy", "true");
  $("#assignmentStatus").textContent = state.editingShelfId
    ? "割り当てを保存中…"
    : "売場を登録中…";
  try {
    const saved = state.editingShelfId
      ? await request(`/api/shelves/${encodeURIComponent(state.editingShelfId)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
      : await request("/api/shelves", { method: "POST", body: JSON.stringify(payload) });
    showToast(state.editingShelfId ? "売場を更新" : "売場を登録");
    await loadShelves();
    if (window.IntelligentiMapEditor?.refreshCatalog) {
      try { await window.IntelligentiMapEditor.refreshCatalog(); } catch { /* Opening the map retries the refresh. */ }
    }
    selectShelf(saved);
    $("#assignmentStatus").textContent = `${saved.name} を保存`;
  } catch (error) {
    $("#assignmentStatus").textContent = error.message;
    showToast(error.message, true);
  } finally {
    submit.disabled = false;
    form.setAttribute("aria-busy", "false");
  }
}

function switchView(name) {
  const products = name === "products";
  const shelves = name === "shelves";
  const map = name === "map";
  $("#productsView").classList.toggle("is-hidden", !products);
  $("#shelvesView").classList.toggle("is-hidden", !shelves);
  $("#mapView").classList.toggle("is-hidden", !map);
  $("#searchBox").classList.toggle("is-hidden", !products);
  $("#newProductButton").classList.toggle("is-hidden", !products);
  $("#readerConnectButton").classList.toggle("is-hidden", map);
  $("#pageTitle").textContent = products ? "商品台帳" : shelves ? "売場構成" : "店舗マップ";
  $("#pageContext").textContent = products ? "PRODUCT LEDGER / 商品・在庫"
    : shelves ? "STORE LAYOUT / 棚" : "INDOOR MAP / 案内レイアウト";
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === name);
  });
  if (map) window.IntelligentiMapEditor?.open();
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorLabel = $("#loginError");
  errorLabel.textContent = "";
  try {
    await request("/admin/session", {
      method: "POST",
      body: JSON.stringify({ password: $("#passwordInput").value }),
    });
    $("#passwordInput").value = "";
    await showApp();
  } catch (error) {
    errorLabel.textContent = error.message;
  }
});

$("#logoutButton").addEventListener("click", async () => {
  await request("/admin/session", { method: "DELETE" }).catch(() => null);
  showLogin();
});
$("#newProductButton").addEventListener("click", () => openProductDialog());
$("#closeDialog").addEventListener("click", () => productDialog.close());
$("#productImageInput").addEventListener("change", selectProductImage);
$("#removeProductImage").addEventListener("click", removeProductImage);
$("#productImagePreviewImage").addEventListener("error", () => {
  $("#productImagePreviewImage").classList.remove("is-visible");
  $("#productImagePlaceholder").classList.remove("is-hidden");
  setProductImageStatus("画像を読み込めません。別の画像を選択してください", "error");
});
productDialog.addEventListener("close", clearProductImagePreviewUrl);
$("#deleteProductButton").addEventListener("click", deleteProduct);
$("#guideProductButton").addEventListener("click", guideProduct);
$("#writeTagButton").addEventListener("click", writeProductTag);
$("#cancelTagWriteButton").addEventListener("click", cancelProductTagWrite);
$("#readerConnectButton").addEventListener("click", connectReader);
$("#readerSettingsButton").addEventListener("click", openReaderSettings);
$("#closeReaderSettings").addEventListener("click", () => readerSettingsDialog.close());
$("#cancelReaderSettings").addEventListener("click", () => readerSettingsDialog.close());
$("#readerSettingsForm").addEventListener("submit", saveReaderSettings);
productForm.addEventListener("submit", saveProduct);
$("#shelfForm").addEventListener("submit", saveShelf);
$("#newShelfButton").addEventListener("click", resetShelfForm);
$("#searchInput").addEventListener("input", () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => loadProducts(), 260);
});
document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

(async () => {
  try {
    const session = await request("/admin/session");
    if (session?.authenticated) await showApp();
    else showLogin();
  } catch {
    showLogin();
  }
})();
