const STORAGE_KEY = "ca-alerta-base-v1";
const NOTIFIED_KEY = "ca-alerta-notified-v1";
const FILE_HANDLE_DB = "ca-alerta-file-handles-v1";
const FILE_HANDLE_STORE = "handles";
const FILE_SYNC_INTERVAL = 5000;
const RENEWAL_MONTHS = 8;
const linkedFileHandles = new Map();
const linkedFilePermissions = new Map();
const observedFileVersions = new Map();
const linkedFileErrors = new Map();
let linkedFilesInitialized = false;
let fileSyncInProgress = false;
let fileSyncTimer = null;
let deferredInstallPrompt = null;
const savedBase = loadPersistentBase();

const state = {
  certificates: savedBase.certificates,
  sources: savedBase.sources,
  updatedAt: savedBase.updatedAt,
  query: "",
  filter: "todos"
};

const els = {
  rows: document.querySelector("#certificateRows"),
  empty: document.querySelector("#emptyState"),
  search: document.querySelector("#searchInput"),
  filter: document.querySelector("#statusFilter"),
  file: document.querySelector("#fileInput"),
  uploadState: document.querySelector("#uploadState"),
  dataView: document.querySelector("#dataView"),
  dropZone: document.querySelector("#dropZone"),
  selectFileLabel: document.querySelector("#selectFileLabel"),
  notificationButton: document.querySelector("#notificationButton"),
  notificationSetup: document.querySelector("#notificationSetup"),
  enableNotificationsButton: document.querySelector("#enableNotificationsButton"),
  installPrompt: document.querySelector("#installPrompt"),
  installPromptTitle: document.querySelector("#installPromptTitle"),
  installPromptText: document.querySelector("#installPromptText"),
  installAppButton: document.querySelector("#installAppButton"),
  installDialog: document.querySelector("#installDialog"),
  clearDataButton: document.querySelector("#clearDataButton"),
  syncStatus: document.querySelector("#syncStatus"),
  syncFilesButton: document.querySelector("#syncFilesButton"),
  panel: document.querySelector("#notificationPanel"),
  notifications: document.querySelector("#notificationList"),
  dialog: document.querySelector("#detailDialog"),
  toast: document.querySelector("#toast")
};

function loadPersistentBase() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || !Array.isArray(saved.certificates)) throw new Error();
    const sources = Array.isArray(saved.sources) ? saved.sources : [];
    const legacySourceNames = sources.length === 1 ? [sources[0].name] : [];
    return {
      certificates: saved.certificates.map(item => ({
        ...item,
        sourceNames: Array.isArray(item.sourceNames) ? item.sourceNames : legacySourceNames
      })),
      sources,
      updatedAt: saved.updatedAt || null
    };
  } catch {
    return { certificates: [], sources: [], updatedAt: null };
  }
}

function savePersistentBase(base = state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    certificates: base.certificates,
    sources: base.sources,
    updatedAt: base.updatedAt
  }));
}

function supportsLinkedFiles() {
  return "showOpenFilePicker" in window && "indexedDB" in window;
}

function isIOSDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandaloneApp() {
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function supportsSystemNotifications() {
  return "Notification" in window
    && "serviceWorker" in navigator
    && "ServiceWorkerRegistration" in window
    && "showNotification" in ServiceWorkerRegistration.prototype;
}

function openInstallDialog() {
  if (typeof els.installDialog.showModal === "function") {
    els.installDialog.showModal();
  } else {
    els.installDialog.setAttribute("open", "");
  }
}

function closeInstallDialog() {
  if (typeof els.installDialog.close === "function") {
    els.installDialog.close();
  } else {
    els.installDialog.removeAttribute("open");
  }
}

function updateInstallExperience() {
  const installed = isStandaloneApp();
  const ios = isIOSDevice();
  const canPrompt = Boolean(deferredInstallPrompt);

  els.installPrompt.hidden = installed || (!ios && !canPrompt);
  if (installed) return;

  if (ios) {
    els.installPromptTitle.textContent = "Instale o CA Alerta no iPhone";
    els.installPromptText.textContent = "Adicione à Tela de Início para usar em tela cheia e liberar notificações no iOS.";
    els.installAppButton.textContent = "Como instalar";
  } else if (canPrompt) {
    els.installPromptTitle.textContent = "Instale o CA Alerta";
    els.installPromptText.textContent = "Abra o painel como aplicativo e mantenha o acesso mais fácil.";
    els.installAppButton.textContent = "Instalar";
  }
}

function openFileHandleDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FILE_HANDLE_DB, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(FILE_HANDLE_STORE)) {
        database.createObjectStore(FILE_HANDLE_STORE, { keyPath: "name" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function waitForTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function saveLinkedFileHandle(name, handle) {
  const database = await openFileHandleDatabase();
  try {
    const transaction = database.transaction(FILE_HANDLE_STORE, "readwrite");
    const completed = waitForTransaction(transaction);
    transaction.objectStore(FILE_HANDLE_STORE).put({ name, handle });
    await completed;
  } finally {
    database.close();
  }
}

async function loadLinkedFileHandles() {
  const database = await openFileHandleDatabase();
  try {
    const transaction = database.transaction(FILE_HANDLE_STORE, "readonly");
    const completed = waitForTransaction(transaction);
    const request = transaction.objectStore(FILE_HANDLE_STORE).getAll();
    const records = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    await completed;
    return records;
  } finally {
    database.close();
  }
}

async function clearLinkedFileHandles() {
  if (!("indexedDB" in window)) return;
  const database = await openFileHandleDatabase();
  try {
    const transaction = database.transaction(FILE_HANDLE_STORE, "readwrite");
    const completed = waitForTransaction(transaction);
    transaction.objectStore(FILE_HANDLE_STORE).clear();
    await completed;
  } finally {
    database.close();
  }
}

function fileVersion(file) {
  return `${Number(file.lastModified) || 0}:${Number(file.size) || 0}`;
}

function sourceMatchesFile(source, file) {
  return Boolean(source)
    && Number(source.lastModified) === Number(file.lastModified)
    && Number(source.size) === Number(file.size);
}

function updateFileSyncStatus() {
  if (!els.syncStatus || !els.syncFilesButton) return;
  if (!supportsLinkedFiles()) {
    els.syncStatus.textContent = isIOSDevice()
      ? "No iPhone, importe o XLSX novamente para atualizar"
      : "Atualização automática indisponível neste navegador";
    els.syncFilesButton.hidden = true;
    return;
  }

  const granted = [...linkedFilePermissions.values()].filter(permission => permission === "granted").length;
  if (granted) {
    const pending = linkedFileHandles.size - granted;
    els.syncStatus.textContent = pending
      ? `${granted} vínculo(s) ativo(s) · ${pending} precisa(m) reconectar`
      : `${granted} planilha(s) vinculada(s) · atualização automática ativa`;
    els.syncFilesButton.textContent = pending ? "Reconectar pendentes" : "Verificar agora";
    els.syncFilesButton.hidden = false;
  } else if (linkedFileHandles.size) {
    els.syncStatus.textContent = "Reconexão necessária para acompanhar o arquivo";
    els.syncFilesButton.textContent = "Reconectar";
    els.syncFilesButton.hidden = false;
  } else if (!linkedFilesInitialized && state.sources.some(source => source.linked)) {
    els.syncStatus.textContent = "Carregando vínculo da planilha…";
    els.syncFilesButton.hidden = true;
  } else {
    els.syncStatus.textContent = "Importação manual · vincule um XLSX para automatizar";
    els.syncFilesButton.hidden = true;
  }
}

function localDate(dateString) {
  const [year, month, day] = String(dateString).slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function daysUntil(dateString) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((localDate(dateString) - today) / 86400000);
}

function addMonthsClamped(date, months) {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return target;
}

function renewalWindowEnd() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return addMonthsClamped(today, RENEWAL_MONTHS);
}

function getStatus(certificate) {
  const days = daysUntil(certificate.expiry);
  if (days < 0) return { key: "vencido", label: "Vencido", detail: `${Math.abs(days)} ${Math.abs(days) === 1 ? "dia" : "dias"} em atraso` };
  if (days <= 30) return { key: "urgente", label: days === 0 ? "Vence hoje" : `${days} dias`, detail: days === 0 ? "Expira hoje" : `Vence em ${days} dias` };
  if (localDate(certificate.expiry) <= renewalWindowEnd()) return { key: "atencao", label: `${days} dias`, detail: `Renovar em até ${RENEWAL_MONTHS} meses · vence em ${days} dias` };
  return { key: "emdia", label: "Em dia", detail: `Vence em ${days} dias` };
}

function formatDate(dateString) {
  return new Intl.DateTimeFormat("pt-BR").format(localDate(dateString));
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function splitCnae(cnae = "") {
  const [code, ...description] = String(cnae).split(" - ");
  return { code, description: description.join(" - ") };
}

function certificateDisplay(item) {
  const registration = String(item.registration || "").trim();
  const reference = String(item.reference || "").trim();
  const cnae = splitCnae(item.cnae);
  if (registration) {
    return {
      code: `CA ${registration}`,
      description: reference || (cnae.code ? `CNAE ${item.cnae}` : "Referência não informada")
    };
  }
  return {
    code: cnae.code ? `CNAE ${cnae.code}` : "CA não informado",
    description: reference || cnae.description || "Referência não informada"
  };
}

function searchableCertificateText(item) {
  return [item.company, item.cnpj, item.registration, item.reference, item.cnae].filter(Boolean).join(" ");
}

function filteredCertificates() {
  const query = state.query.trim().toLocaleLowerCase("pt-BR");
  return state.certificates
    .filter(item => state.filter === "todos" || getStatus(item).key === state.filter)
    .filter(item => !query || searchableCertificateText(item).toLocaleLowerCase("pt-BR").includes(query))
    .sort((a, b) => localDate(a.expiry) - localDate(b.expiry));
}

function render() {
  const hasData = state.certificates.length > 0;
  updateInstallExperience();
  els.uploadState.hidden = hasData;
  els.dataView.hidden = !hasData;
  els.notificationButton.hidden = !hasData;
  document.querySelector("#importButtonLabel").textContent = supportsLinkedFiles()
    ? (hasData ? "Vincular outro XLSX" : "Vincular XLSX")
    : (hasData ? "Adicionar XLSX" : "Importar XLSX");
  els.selectFileLabel.textContent = supportsLinkedFiles() ? "Vincular XLSX" : "Selecionar XLSX";
  updateFileSyncStatus();
  if (!hasData) {
    closeNotificationPanel();
    return;
  }

  const filtered = filteredCertificates();
  const indexByItem = new Map(state.certificates.map((item, index) => [item, index]));
  els.rows.innerHTML = filtered.map((item) => {
    const status = getStatus(item);
    const certificate = certificateDisplay(item);
    const originalIndex = indexByItem.get(item);
    return `<tr>
      <td data-label="Empresa"><div class="company-cell"><span class="company-logo">${escapeHtml(initials(item.company))}</span><div><strong title="${escapeHtml(item.company)}">${escapeHtml(item.company)}</strong><small>Cliente monitorado</small></div></div></td>
      <td data-label="CNPJ">${escapeHtml(item.cnpj)}</td>
      <td class="certificate-cell" data-label="CA / Referência"><span class="certificate-code">${escapeHtml(certificate.code)}</span><span class="certificate-description" title="${escapeHtml(certificate.description)}">${escapeHtml(certificate.description)}</span></td>
      <td data-label="Validade"><div class="date-cell"><strong>${formatDate(item.expiry)}</strong><small>${escapeHtml(status.detail)}</small></div></td>
      <td data-label="Status"><span class="status-badge status-${status.key}">${escapeHtml(status.label)}</span></td>
      <td class="row-actions-cell"><button class="row-action" data-detail="${originalIndex}" aria-label="Ver detalhes de ${escapeHtml(item.company)}">•••</button></td>
    </tr>`;
  }).join("");
  els.empty.hidden = filtered.length > 0;
  document.querySelector("table").hidden = filtered.length === 0;
  document.querySelector("#resultSummary").textContent = `${filtered.length} ${filtered.length === 1 ? "registro encontrado" : "registros encontrados"}`;
  document.querySelector("#paginationText").textContent = `Mostrando ${filtered.length} de ${state.certificates.length} registros`;
  const sourceLabel = state.sources.length === 1 ? state.sources[0].name : `${state.sources.length} planilhas combinadas`;
  document.querySelector("#currentFileName").textContent = sourceLabel;
  document.querySelector("#currentFileName").title = state.sources.map(source => source.name).join(", ");
  document.querySelector("#lastUpdated").textContent = state.updatedAt
    ? `Atualizada em ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(state.updatedAt))}`
    : "Base restaurada";
  renderStats();
  renderNotifications();
  updateNotificationSetup();
}

function renderStats() {
  const counts = { vencido: 0, urgente: 0, atencao: 0, emdia: 0 };
  state.certificates.forEach(item => counts[getStatus(item).key]++);
  document.querySelector("#statTotal").textContent = state.certificates.length;
  document.querySelector("#statExpired").textContent = counts.vencido;
  document.querySelector("#statUrgent").textContent = counts.urgente;
  document.querySelector("#statAttention").textContent = counts.atencao;
  document.querySelector("#expiredHint").textContent = counts.vencido ? "ação imediata" : "nenhuma pendência";
  const priorities = counts.vencido + counts.urgente + counts.atencao;
  document.querySelector("#insightTitle").textContent = priorities ? `${priorities} ${priorities === 1 ? "certificado requer" : "certificados requerem"} sua atenção` : "Seus certificados estão em dia";
  document.querySelector("#insightText").textContent = priorities ? `Há ${counts.vencido} vencido(s), ${counts.urgente} em até 30 dias e ${counts.atencao} na janela de renovação de ${RENEWAL_MONTHS} meses.` : `Nenhuma renovação prevista para os próximos ${RENEWAL_MONTHS} meses.`;
  document.querySelector("#notificationDot").hidden = priorities === 0;
  updateAppBadge(priorities);
}

function updateAppBadge(count) {
  try {
    if (count > 0 && "setAppBadge" in navigator) {
      navigator.setAppBadge(count).catch(() => {});
    } else if ("clearAppBadge" in navigator) {
      navigator.clearAppBadge().catch(() => {});
    }
  } catch {
    // Badges são um aprimoramento opcional e não devem interromper o painel.
  }
}

function renderNotifications() {
  const urgent = state.certificates.filter(item => ["vencido", "urgente", "atencao"].includes(getStatus(item).key)).sort((a, b) => localDate(a.expiry) - localDate(b.expiry));
  document.querySelector("#alertCount").textContent = urgent.length;
  els.notifications.innerHTML = urgent.length ? urgent.map(item => {
    const status = getStatus(item);
    const certificate = certificateDisplay(item);
    return `<div class="notification-item"><span class="notification-symbol ${status.key}">${status.key === "vencido" ? "!" : "◷"}</span><div><strong>${escapeHtml(item.company)}</strong><p>${escapeHtml(certificate.code)} · ${status.key === "vencido" ? "está vencido" : `vence em ${daysUntil(item.expiry)} dias`} · ${formatDate(item.expiry)}</p></div></div>`;
  }).join("") : `<div class="notification-empty">Tudo certo por aqui. Nenhum CA na janela de renovação.</div>`;
}

function updateNotificationSetup() {
  const title = document.querySelector("#notificationSetupTitle");
  const text = document.querySelector("#notificationSetupText");
  els.notificationSetup.classList.remove("enabled", "blocked");
  els.enableNotificationsButton.hidden = false;
  els.enableNotificationsButton.disabled = false;
  els.enableNotificationsButton.dataset.action = "notifications";

  if (isIOSDevice() && !isStandaloneApp()) {
    els.notificationSetup.classList.add("blocked");
    title.textContent = "Instale o app para ativar notificações";
    text.textContent = "No iPhone, os avisos só podem ser autorizados no CA Alerta aberto pela Tela de Início.";
    els.enableNotificationsButton.textContent = "Como instalar";
    els.enableNotificationsButton.dataset.action = "install";
    return;
  }

  if (!supportsSystemNotifications()) {
    els.notificationSetup.classList.add("blocked");
    title.textContent = isIOSDevice() ? "Atualize o iPhone para receber avisos" : "Notificações indisponíveis neste navegador";
    text.textContent = isIOSDevice()
      ? "O CA Alerta precisa do iOS 16.4 ou superior para usar notificações na Tela de Início."
      : "Use uma versão atual do Chrome, Edge, Firefox ou Safari.";
    els.enableNotificationsButton.hidden = true;
    return;
  }

  if (Notification.permission === "granted") {
    els.notificationSetup.classList.add("enabled");
    title.textContent = "Notificações ativadas";
    text.textContent = `Os avisos são verificados quando você abre ou volta ao app. Toque ao lado para testar agora.`;
    els.enableNotificationsButton.textContent = "Testar aviso";
  } else if (Notification.permission === "denied") {
    els.notificationSetup.classList.add("blocked");
    title.textContent = "Notificações bloqueadas";
    text.textContent = "Libere as notificações nas configurações do navegador para receber os avisos.";
    els.enableNotificationsButton.textContent = "Bloqueadas";
    els.enableNotificationsButton.disabled = true;
  } else {
    title.textContent = "Ative os avisos de vencimento";
    text.textContent = `Receba uma notificação para CAs vencidos ou que vencem nos próximos ${RENEWAL_MONTHS} meses.`;
    els.enableNotificationsButton.textContent = "Ativar notificações";
    els.enableNotificationsButton.disabled = false;
  }
}

async function showBrowserNotification(title, options = {}) {
  const notificationOptions = {
    icon: new URL("icon-192.png", document.baseURI).href,
    badge: new URL("icon-192.png", document.baseURI).href,
    ...options
  };
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    const registration = await navigator.serviceWorker.ready;
    if ("showNotification" in registration) {
      await registration.showNotification(title, notificationOptions);
      return;
    }
  }
  if (typeof Notification === "function") {
    new Notification(title, notificationOptions);
    return;
  }
  throw new Error("Notificações do sistema indisponíveis.");
}

async function requestNotifications() {
  if (!supportsSystemNotifications()) return;
  try {
    if (Notification.permission === "granted") {
      await showBrowserNotification("CA Alerta está ativo", { body: "Os avisos de vencimento estão funcionando.", tag: "ca-alerta-teste" });
      return;
    }
    const permission = await Notification.requestPermission();
    updateNotificationSetup();
    if (permission === "granted") {
      showToast("Notificações ativadas", "Você receberá avisos sobre os CAs prioritários.");
      await showBrowserNotification("CA Alerta está ativo", {
        body: "Os avisos estão funcionando neste aparelho.",
        tag: "ca-alerta-primeiro-teste"
      });
      await checkExpiringNotifications();
    } else {
      showToast("Notificações não ativadas", "A permissão foi bloqueada ou recusada no navegador.", true);
    }
  } catch {
    showToast("Notificações indisponíveis", "Abra o site em localhost ou HTTPS para ativar os avisos.", true);
  }
}

async function checkExpiringNotifications() {
  if (!supportsSystemNotifications() || Notification.permission !== "granted") return;
  const urgent = state.certificates
    .filter(item => ["vencido", "urgente", "atencao"].includes(getStatus(item).key))
    .sort((a, b) => localDate(a.expiry) - localDate(b.expiry));
  if (!urgent.length) return;

  const todayKey = new Date().toLocaleDateString("en-CA");
  let notified = {};
  try { notified = JSON.parse(localStorage.getItem(NOTIFIED_KEY)) || {}; } catch { notified = {}; }
  const signature = urgent.map(item => `${certificateKey(item)}|${item.expiry}|${getStatus(item).key}`).join(";");
  let signatureHash = 0;
  for (let index = 0; index < signature.length; index++) signatureHash = (signatureHash * 31 + signature.charCodeAt(index)) >>> 0;
  const recordKey = `summary|${todayKey}|${signatureHash.toString(36)}`;
  if (notified[recordKey]) return;

  const counts = { vencido: 0, urgente: 0, atencao: 0 };
  urgent.forEach(item => counts[getStatus(item).key]++);
  await showBrowserNotification(`${urgent.length} ${urgent.length === 1 ? "CA precisa" : "CAs precisam"} de acompanhamento`, {
    body: `${counts.vencido} vencido(s), ${counts.urgente} em até 30 dias e ${counts.atencao} na janela de ${RENEWAL_MONTHS} meses. Abra o painel para ver os clientes.`,
    tag: `ca-alerta-resumo-${todayKey}`,
    data: { url: location.href.split("#")[0] + "#certificados" }
  });
  notified[recordKey] = Date.now();

  const cutoff = Date.now() - 35 * 86400000;
  notified = Object.fromEntries(Object.entries(notified).filter(([, timestamp]) => timestamp > cutoff));
  localStorage.setItem(NOTIFIED_KEY, JSON.stringify(notified));
}

async function safelyCheckExpiringNotifications() {
  try {
    await checkExpiringNotifications();
  } catch (error) {
    console.warn("Não foi possível verificar as notificações de vencimento.", error);
  }
}

function setFilter(filter) {
  state.filter = filter;
  els.filter.value = filter;
  render();
  document.querySelector("#certificados").scrollIntoView({ behavior: "smooth", block: "start" });
}

function showDetail(index) {
  const item = state.certificates[index];
  if (!item) return;
  const status = getStatus(item);
  document.querySelector("#dialogCompany").textContent = item.company;
  document.querySelector("#dialogCnpj").textContent = item.cnpj;
  document.querySelector("#dialogRegistration").textContent = item.registration ? `CA ${item.registration}` : "Não informado";
  document.querySelector("#dialogDate").textContent = formatDate(item.expiry);
  document.querySelector("#dialogReference").textContent = item.reference || (item.cnae ? `CNAE ${item.cnae}` : "Não informada");
  const dialogStatus = document.querySelector("#dialogStatus");
  dialogStatus.className = `dialog-status status-${status.key}`;
  dialogStatus.textContent = status.key === "vencido" ? `Ação necessária: ${status.detail}.` : `Situação: ${status.detail}.`;
  els.dialog.showModal();
}

function showToast(title, message, error = false) {
  document.querySelector("#toastTitle").textContent = title;
  document.querySelector("#toastMessage").textContent = message;
  document.querySelector(".toast-icon").textContent = error ? "!" : "✓";
  document.querySelector(".toast-icon").style.background = error ? "var(--danger)" : "var(--green)";
  els.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 4500);
}

// Leitor enxuto de XLSX para planilhas simples. XLSX é um arquivo ZIP com XMLs internos.
async function unzipXlsx(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Arquivo XLSX inválido.");
  const entries = view.getUint16(end + 10, true);
  const centralOffset = view.getUint32(end + 16, true);
  const files = new Map();
  let cursor = centralOffset;
  for (let i = 0; i < entries; i++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(start, start + compressedSize);
    let content;
    if (method === 0) content = compressed;
    else if (method === 8) {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      content = new Uint8Array(await new Response(stream).arrayBuffer());
    } else throw new Error("Método de compactação não suportado.");
    files.set(name, new TextDecoder().decode(content));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function excelSerialToIso(serial, date1904 = false) {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Number(serial) * 86400000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function readSheetRows(xml, sharedStrings) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return [...doc.querySelectorAll("sheetData row")].map(row => {
    const result = {};
    const cellTypes = {};
    [...row.querySelectorAll(":scope > c")].forEach(cell => {
      const column = String(cell.getAttribute("r") || "").replace(/\d/g, "");
      if (!column) return;
      const type = cell.getAttribute("t") || "n";
      const inline = [...cell.querySelectorAll("is t")].map(node => node.textContent).join("");
      const raw = cell.querySelector("v")?.textContent ?? inline;
      result[column] = type === "s" ? sharedStrings[Number(raw)] ?? "" : raw;
      cellTypes[column] = type;
    });
    Object.defineProperties(result, {
      __rowNumber: { value: Number(row.getAttribute("r")) || null },
      __cellTypes: { value: cellTypes }
    });
    return result;
  });
}

function normalizeZipPath(path) {
  return String(path).split("/").reduce((parts, part) => {
    if (!part || part === ".") return parts;
    if (part === "..") parts.pop();
    else parts.push(part);
    return parts;
  }, []).join("/");
}

function workbookInfo(files) {
  const workbookDoc = new DOMParser().parseFromString(files.get("xl/workbook.xml") || "<workbook/>", "application/xml");
  const workbookProperties = workbookDoc.getElementsByTagNameNS("*", "workbookPr")[0];
  const date1904 = ["1", "true"].includes(workbookProperties?.getAttribute("date1904"));
  const firstSheet = workbookDoc.getElementsByTagNameNS("*", "sheet")[0];
  const relationshipId = firstSheet?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || firstSheet?.getAttribute("r:id");
  const relationshipsDoc = new DOMParser().parseFromString(files.get("xl/_rels/workbook.xml.rels") || "<Relationships/>", "application/xml");
  const relationship = [...relationshipsDoc.getElementsByTagNameNS("*", "Relationship")].find(node => node.getAttribute("Id") === relationshipId);
  const target = relationship?.getAttribute("Target");
  const sheetName = target
    ? normalizeZipPath(target.startsWith("/") ? target.slice(1) : `xl/${target}`)
    : [...files.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
  return { date1904, sheetName };
}

function normalizeHeader(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function detectColumns(header) {
  const findColumn = pattern => Object.keys(header).find(col => pattern.test(normalizeHeader(header[col])));
  return {
    cnpj: findColumn(/cnpj/),
    company: findColumn(/razao social|empresa|cliente/),
    registration: findColumn(/^(registro\s+)?ca$|certificado.*aprovacao|numero.*ca/),
    reference: findColumn(/referencia|produto|modelo/),
    cnae: findColumn(/\bcnae\b/),
    expiry: findColumn(/expira|vencimento|validade/)
  };
}

function rowToCertificate(row, cols, date1904) {
  const expiryRaw = row[cols.expiry];
  const expiry = /^\d+(\.\d+)?$/.test(expiryRaw) ? excelSerialToIso(expiryRaw, date1904) : normalizeDate(expiryRaw);
  const cnpjRaw = String(row[cols.cnpj] || "").trim();
  const cnpjType = row.__cellTypes?.[cols.cnpj];
  const numericCnpj = cnpjType === "n" && /^\d+(?:\.0+)?$/.test(cnpjRaw)
    ? cnpjRaw.split(".")[0].padStart(14, "0")
    : "";
  return {
    cnpj: numericCnpj.length === 14
      ? `${numericCnpj.slice(0, 2)}.${numericCnpj.slice(2, 5)}.${numericCnpj.slice(5, 8)}/${numericCnpj.slice(8, 12)}-${numericCnpj.slice(12)}`
      : cnpjRaw,
    company: String(row[cols.company] || "").trim(),
    registration: String(row[cols.registration] || "").trim(),
    reference: String(row[cols.reference] || "").trim(),
    cnae: String(row[cols.cnae] || "").trim(),
    expiry
  };
}

function parseCertificateRows(rows, cols, date1904, headerIndex) {
  const mappedColumns = Object.values(cols).filter(Boolean);
  const candidates = rows.slice(headerIndex + 1)
    .filter(row => mappedColumns.some(column => String(row[column] ?? "").trim()));
  const certificates = [];
  const rejected = [];

  candidates.forEach((row, index) => {
    const item = rowToCertificate(row, cols, date1904);
    const reasons = [];
    if (!item.cnpj) reasons.push("CNPJ não informado");
    if (!item.company) reasons.push("Razão Social não informada");
    if (!item.expiry) {
      reasons.push(String(row[cols.expiry] ?? "").trim() ? "data de validade inválida" : "data de validade não informada");
    }
    if (reasons.length) {
      rejected.push({ rowNumber: row.__rowNumber || headerIndex + index + 2, reasons });
    } else {
      certificates.push(item);
    }
  });

  return { certificates, rejected };
}

async function parseXlsx(file) {
  const files = await unzipXlsx(await file.arrayBuffer());
  const sharedDoc = new DOMParser().parseFromString(files.get("xl/sharedStrings.xml") || "<sst/>", "application/xml");
  const shared = [...sharedDoc.querySelectorAll("si")].map(si => [...si.querySelectorAll("t")].map(t => t.textContent).join(""));
  const { date1904, sheetName } = workbookInfo(files);
  if (!sheetName) throw new Error("Nenhuma aba de dados foi encontrada.");
  const rows = readSheetRows(files.get(sheetName), shared);
  const headerIndex = rows.findIndex(row => {
    const values = Object.values(row).map(normalizeHeader);
    return values.some(value => /\bcnpj\b/.test(value)) && values.some(value => /expira|vencimento|validade/.test(value));
  });
  if (headerIndex < 0) throw new Error("Cabeçalhos CNPJ e Data de Validade não encontrados.");
  const cols = detectColumns(rows[headerIndex]);
  if (!cols.cnpj || !cols.company || !cols.expiry) throw new Error("A planilha precisa conter CNPJ, Razão Social e Data de Validade.");
  return parseCertificateRows(rows, cols, date1904, headerIndex);
}

function normalizeDate(value) {
  const stringValue = String(value ?? "").trim();
  const isoMatch = stringValue.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const iso = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    return isValidIsoDate(iso) ? iso : "";
  }
  const match = stringValue.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (!match) return "";
  const iso = `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  return isValidIsoDate(iso) ? iso : "";
}

function isValidIsoDate(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]);
}

function certificateKey(item) {
  const normalizeIdentity = value => normalizeHeader(value).replace(/[^a-z0-9]/g, "");
  const owner = normalizeIdentity(item.cnpj) || normalizeIdentity(item.company);
  const registration = normalizeIdentity(item.registration);
  const reference = normalizeIdentity(item.reference);
  const cnae = normalizeIdentity(String(item.cnae || "").split(" - ")[0]);
  const identity = registration
    ? `ca:${registration}`
    : reference
      ? `ref:${reference}`
      : cnae
        ? `cnae:${cnae}`
        : `sem-id:${item.expiry}`;
  return `${owner}|${identity}`;
}

function certificateSourceNames(item) {
  return Array.isArray(item.sourceNames) ? item.sourceNames.filter(Boolean) : [];
}

function mergeCertificates(current, imported, sourceName) {
  const previousKeys = new Set(current.map(certificateKey));
  const retained = current.flatMap(item => {
    const sourceNames = certificateSourceNames(item);
    if (!sourceNames.includes(sourceName)) return [{ ...item, sourceNames }];
    const remainingSources = sourceNames.filter(name => name !== sourceName);
    return remainingSources.length ? [{ ...item, sourceNames: remainingSources }] : [];
  });
  const merged = new Map();
  retained.forEach(item => {
    const key = certificateKey(item);
    const existing = merged.get(key);
    const sourceNames = [...new Set([...certificateSourceNames(existing || {}), ...certificateSourceNames(item)])];
    merged.set(key, { ...existing, ...item, sourceNames });
  });
  let added = 0;
  let updated = 0;
  imported.forEach(item => {
    const key = certificateKey(item);
    if (previousKeys.has(key)) updated++;
    else added++;
    const existing = merged.get(key);
    const sourceNames = [...new Set([...certificateSourceNames(existing || {}), sourceName])];
    merged.set(key, { ...existing, ...item, sourceNames });
  });
  const certificates = [...merged.values()];
  const finalKeys = new Set(certificates.map(certificateKey));
  const removed = new Set(current.map(certificateKey).filter(key => !finalKeys.has(key))).size;
  return { certificates, added, updated, removed };
}

async function handleFile(file, options = {}) {
  if (!file || !file.name.toLowerCase().endsWith(".xlsx")) {
    showToast("Arquivo não suportado", "Selecione uma planilha no formato .xlsx.", true);
    return false;
  }
  try {
    const { certificates: imported, rejected } = await parseXlsx(file);
    if (rejected.length) {
      const preview = rejected.slice(0, 3)
        .map(item => `linha ${item.rowNumber}: ${item.reasons.join(", ")}`)
        .join("; ");
      const remaining = rejected.length > 3 ? `; e mais ${rejected.length - 3}` : "";
      throw new Error(`Importação cancelada. Corrija ${rejected.length} linha(s): ${preview}${remaining}.`);
    }
    if (!imported.length) throw new Error("Nenhum registro válido foi encontrado.");
    const merged = mergeCertificates(state.certificates, imported, file.name);
    const importedAt = new Date().toISOString();
    const sources = [
      ...state.sources.filter(source => source.name !== file.name),
      {
        name: file.name,
        importedAt,
        records: imported.length,
        linked: Boolean(options.linked),
        lastModified: Number(file.lastModified) || null,
        size: Number(file.size) || null
      }
    ];
    savePersistentBase({ certificates: merged.certificates, sources, updatedAt: importedAt });
    state.certificates = merged.certificates;
    state.sources = sources;
    state.updatedAt = importedAt;
    state.filter = "todos";
    state.query = "";
    els.search.value = "";
    els.filter.value = "todos";
    render();
    const title = options.automatic
      ? "Planilha atualizada automaticamente"
      : options.linked
        ? "Planilha vinculada"
        : "Planilha adicionada";
    showToast(title, `${merged.added} novo(s), ${merged.updated} atualizado(s) e ${merged.removed} removido(s).`);
  } catch (error) {
    const title = options.automatic ? "Não foi possível atualizar a planilha" : "Não foi possível importar";
    if (!options.silentError) {
      showToast(title, error.message || "Revise a estrutura da planilha e tente novamente.", true);
    }
    return false;
  } finally {
    els.file.value = "";
  }
  await safelyCheckExpiringNotifications();
  return true;
}

async function getFileHandlePermission(handle, requestPermission = false) {
  if (typeof handle.queryPermission !== "function") return "granted";
  let permission = await handle.queryPermission({ mode: "read" });
  if (permission === "prompt" && requestPermission && typeof handle.requestPermission === "function") {
    permission = await handle.requestPermission({ mode: "read" });
  }
  return permission;
}

async function rememberLinkedFile(handle, file) {
  linkedFileHandles.set(file.name, handle);
  linkedFilePermissions.set(file.name, "granted");
  observedFileVersions.set(file.name, fileVersion(file));
  linkedFileErrors.delete(file.name);
  updateFileSyncStatus();
  try {
    await saveLinkedFileHandle(file.name, handle);
    return true;
  } catch (error) {
    console.warn("Não foi possível guardar o vínculo da planilha.", error);
    showToast("Vínculo temporário", "A atualização automática funcionará somente enquanto esta aba permanecer aberta.", true);
    return false;
  }
}

async function importLinkedFileHandle(handle) {
  try {
    const permission = await getFileHandlePermission(handle, true);
    if (permission !== "granted") {
      showToast("Acesso não autorizado", "Permita a leitura do arquivo para ativar a atualização automática.", true);
      return false;
    }
    const file = await handle.getFile();
    const imported = await handleFile(file, { linked: true });
    if (!imported) return false;
    await rememberLinkedFile(handle, file);
    render();
    return true;
  } catch (error) {
    if (error?.name !== "AbortError") {
      showToast("Não foi possível vincular", "O navegador não conseguiu acompanhar este arquivo.", true);
    }
    return false;
  }
}

async function selectSpreadsheet() {
  if (!supportsLinkedFiles()) {
    els.file.click();
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      id: "ca-alerta-xlsx",
      multiple: false,
      excludeAcceptAllOption: true,
      types: [{
        description: "Planilha do Excel",
        accept: { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"] }
      }]
    });
    await importLinkedFileHandle(handle);
  } catch (error) {
    if (error?.name !== "AbortError") {
      showToast("Não foi possível abrir o arquivo", "Use uma conexão HTTPS ou localhost e tente novamente.", true);
    }
  }
}

async function checkLinkedFiles({ force = false, report = false } = {}) {
  if (fileSyncInProgress || !linkedFileHandles.size || document.visibilityState === "hidden") return 0;
  fileSyncInProgress = true;
  let updates = 0;
  try {
    for (const [name, handle] of linkedFileHandles) {
      try {
        const permission = await getFileHandlePermission(handle);
        linkedFilePermissions.set(name, permission);
        if (permission !== "granted") continue;

        const file = await handle.getFile();
        const version = fileVersion(file);
        const source = state.sources.find(item => item.name === name);
        const alreadyImported = sourceMatchesFile(source, file);
        const previousAttempt = observedFileVersions.get(name) === version;
        const previousError = linkedFileErrors.get(name) === version;
        observedFileVersions.set(name, version);
        if (alreadyImported || (previousAttempt && !force) || (previousError && !force)) continue;

        const imported = await handleFile(file, {
          linked: true,
          automatic: true,
          silentError: previousError && !force
        });
        if (imported) {
          linkedFileErrors.delete(name);
          updates++;
        } else {
          linkedFileErrors.set(name, version);
        }
      } catch (error) {
        linkedFilePermissions.set(name, error?.name === "NotAllowedError" ? "prompt" : "error");
        if (!linkedFileErrors.has(name) || force) {
          showToast("Falha ao acompanhar planilha", `${name}: reconecte o arquivo para continuar recebendo atualizações.`, true);
        }
        linkedFileErrors.set(name, "access-error");
      }
    }
  } finally {
    fileSyncInProgress = false;
    updateFileSyncStatus();
  }
  if (report && updates === 0) {
    showToast("Planilhas verificadas", "Nenhuma alteração nova foi encontrada.");
  }
  return updates;
}

async function reconnectLinkedFiles() {
  if (!linkedFileHandles.size) return selectSpreadsheet();
  for (const [name, handle] of linkedFileHandles) {
    try {
      const permission = await getFileHandlePermission(handle, true);
      linkedFilePermissions.set(name, permission);
      if (permission === "granted") linkedFileErrors.delete(name);
    } catch {
      linkedFilePermissions.set(name, "error");
    }
  }
  updateFileSyncStatus();
  const granted = [...linkedFilePermissions.values()].filter(permission => permission === "granted").length;
  if (!granted) {
    showToast("Reconexão necessária", "O navegador não liberou acesso a nenhuma planilha vinculada.", true);
    return;
  }
  await checkLinkedFiles({ force: true, report: true });
}

async function initializeLinkedFiles() {
  if (!supportsLinkedFiles()) {
    linkedFilesInitialized = true;
    updateFileSyncStatus();
    return;
  }
  try {
    const records = await loadLinkedFileHandles();
    for (const record of records) {
      if (!record?.name || record.handle?.kind !== "file") continue;
      linkedFileHandles.set(record.name, record.handle);
      const permission = await getFileHandlePermission(record.handle);
      linkedFilePermissions.set(record.name, permission);
    }
  } catch (error) {
    console.warn("Não foi possível restaurar os vínculos das planilhas.", error);
  } finally {
    linkedFilesInitialized = true;
    updateFileSyncStatus();
  }
  await checkLinkedFiles();
  if (!fileSyncTimer) {
    fileSyncTimer = setInterval(checkLinkedFiles, FILE_SYNC_INTERVAL);
  }
}

document.querySelector("#importButton").addEventListener("click", selectSpreadsheet);
els.dropZone.addEventListener("click", selectSpreadsheet);
els.dropZone.addEventListener("dragover", event => {
  event.preventDefault();
  els.dropZone.classList.add("drag-over");
});
els.dropZone.addEventListener("dragleave", () => els.dropZone.classList.remove("drag-over"));
els.dropZone.addEventListener("drop", event => {
  event.preventDefault();
  els.dropZone.classList.remove("drag-over");
  handleFile(event.dataTransfer.files[0]);
});
els.file.addEventListener("change", event => handleFile(event.target.files[0]));
els.syncFilesButton.addEventListener("click", reconnectLinkedFiles);
els.search.addEventListener("input", event => { state.query = event.target.value; render(); });
els.filter.addEventListener("change", event => { state.filter = event.target.value; render(); });
document.querySelectorAll(".stat-card").forEach(card => {
  card.addEventListener("click", () => setFilter(card.dataset.filter));
  card.addEventListener("keydown", event => {
    if (!["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    setFilter(card.dataset.filter);
  });
});
document.querySelector("#viewUrgentButton").addEventListener("click", () => {
  const priority = ["vencido", "urgente", "atencao"].find(key => state.certificates.some(item => getStatus(item).key === key));
  setFilter(priority || "todos");
});
els.rows.addEventListener("click", event => {
  const button = event.target.closest("[data-detail]");
  if (button) showDetail(Number(button.dataset.detail));
});
function closeNotificationPanel() {
  els.panel.hidden = true;
  els.notificationButton.setAttribute("aria-expanded", "false");
}

els.notificationButton.addEventListener("click", event => {
  event.stopPropagation();
  const willOpen = els.panel.hidden;
  if (!willOpen) return closeNotificationPanel();
  els.panel.hidden = false;
  event.currentTarget.setAttribute("aria-expanded", "true");
});
document.addEventListener("click", event => {
  if (!els.panel.hidden && !els.panel.contains(event.target)) closeNotificationPanel();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !els.panel.hidden) {
    closeNotificationPanel();
    els.notificationButton.focus();
  }
});
document.querySelector("#closeDialog").addEventListener("click", () => els.dialog.close());
document.querySelector("#closeToast").addEventListener("click", () => els.toast.classList.remove("show"));
document.querySelector("#closeInstallDialog").addEventListener("click", closeInstallDialog);
document.querySelector("#confirmInstallDialog").addEventListener("click", closeInstallDialog);
els.installAppButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) {
    openInstallDialog();
    return;
  }

  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  updateInstallExperience();
});
els.enableNotificationsButton.addEventListener("click", () => {
  if (els.enableNotificationsButton.dataset.action === "install") {
    openInstallDialog();
    return;
  }
  requestNotifications();
});
els.clearDataButton.addEventListener("click", async () => {
  if (!window.confirm("Deseja apagar todas as planilhas e certificados salvos neste navegador?")) return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(NOTIFIED_KEY);
  try {
    await clearLinkedFileHandles();
  } catch (error) {
    console.warn("Não foi possível remover os vínculos salvos.", error);
  }
  linkedFileHandles.clear();
  linkedFilePermissions.clear();
  observedFileVersions.clear();
  linkedFileErrors.clear();
  state.certificates = [];
  state.sources = [];
  state.updatedAt = null;
  state.query = "";
  state.filter = "todos";
  els.search.value = "";
  els.filter.value = "todos";
  render();
  showToast("Base removida", "O site está pronto para receber uma nova planilha.");
});

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallExperience();
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  updateInstallExperience();
  updateNotificationSetup();
});
window.matchMedia("(display-mode: standalone)").addEventListener?.("change", () => {
  updateInstallExperience();
  updateNotificationSetup();
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js")
    .then(() => updateNotificationSetup())
    .catch(() => {});
}

render();
initializeLinkedFiles();
setTimeout(safelyCheckExpiringNotifications, 1200);
setInterval(safelyCheckExpiringNotifications, 6 * 60 * 60 * 1000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    safelyCheckExpiringNotifications();
    checkLinkedFiles();
  }
});
