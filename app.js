const STORAGE_KEY = "ca-alerta-base-v1";
const NOTIFIED_KEY = "ca-alerta-notified-v1";
const PUSH_DEVICE_KEY = "ca-alerta-push-device-v1";
const FILE_HANDLE_DB = "ca-alerta-file-handles-v1";
const FILE_HANDLE_STORE = "handles";
const DATA_DB = "ca-alerta-data-v1";
const DATA_STORE = "base";
const DATA_RECORD = "current";
const ROWS_PAGE_SIZE = 200;
const NOTIFICATION_PANEL_LIMIT = 100;
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
let swRegistrationFailed = false;
let dailyPushActive = false;
let dailyPushSyncTimer = null;
let pendingColumnMapping = null;
let dailyPushTime = "09:00";
let indexedStorageAvailable = true;
let dataDatabasePromise = null;
let persistentStorageRequested = false;
let searchTimer = null;
const pushConfig = Object.freeze({
  apiBaseUrl: String(window.CA_ALERTA_PUSH_CONFIG?.apiBaseUrl || "").replace(/\/$/, ""),
  vapidPublicKey: String(window.CA_ALERTA_PUSH_CONFIG?.vapidPublicKey || "")
});
// A base começa vazia e é carregada do IndexedDB em startApp().
const state = {
  certificates: [],
  sources: [],
  tasks: [],
  updatedAt: null,
  changedAt: null,
  loaded: false,
  visibleRows: ROWS_PAGE_SIZE,
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
  tasksButton: document.querySelector("#tasksButton"),
  taskBadge: document.querySelector("#taskBadge"),
  tasksManagerDialog: document.querySelector("#tasksManagerDialog"),
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
  showMoreButton: document.querySelector("#showMoreButton"),
  panel: document.querySelector("#notificationPanel"),
  notifications: document.querySelector("#notificationList"),
  dialog: document.querySelector("#detailDialog"),
  taskList: document.querySelector("#taskList"),
  tasksEmpty: document.querySelector("#tasksEmpty"),
  taskDialog: document.querySelector("#taskDialog"),
  taskForm: document.querySelector("#taskForm"),
  taskCertificate: document.querySelector("#taskCertificate"),
  columnMappingDialog: document.querySelector("#columnMappingDialog"),
  columnMappingForm: document.querySelector("#columnMappingForm"),
  toast: document.querySelector("#toast")
};

function emptyBase() {
  return { certificates: [], sources: [], tasks: [], updatedAt: null, changedAt: null };
}

function normalizeSavedBase(saved) {
  if (!saved || !Array.isArray(saved.certificates)) return emptyBase();
  const sources = Array.isArray(saved.sources) ? saved.sources : [];
  const legacySourceNames = sources.length === 1 ? [sources[0].name] : [];
  return {
    certificates: saved.certificates.map(item => ({
      ...item,
      sourceNames: Array.isArray(item.sourceNames) ? item.sourceNames : legacySourceNames
    })),
    sources,
    tasks: Array.isArray(saved.tasks) ? saved.tasks.map(normalizeSavedTask).filter(Boolean) : [],
    updatedAt: saved.updatedAt || null,
    changedAt: saved.changedAt || saved.updatedAt || null
  };
}

function readLegacyBase() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function removeLegacyBase() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Sem acesso ao localStorage não há cópia antiga para remover.
  }
}

// O localStorage tem limite de ~5 milhões de caracteres; bases grandes ficam no IndexedDB.
function openDataDatabase() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("IndexedDB indisponível."));
  if (!dataDatabasePromise) {
    dataDatabasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATA_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DATA_STORE)) request.result.createObjectStore(DATA_STORE);
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          dataDatabasePromise = null;
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("O banco local está bloqueado por outra aba do CA Alerta."));
    }).catch(error => {
      dataDatabasePromise = null;
      throw error;
    });
  }
  return dataDatabasePromise;
}

async function readStoredBase() {
  const database = await openDataDatabase();
  const transaction = database.transaction(DATA_STORE, "readonly");
  const completed = waitForTransaction(transaction);
  const request = transaction.objectStore(DATA_STORE).get(DATA_RECORD);
  const record = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await completed;
  return record;
}

async function writeStoredBase(record) {
  const database = await openDataDatabase();
  const transaction = database.transaction(DATA_STORE, "readwrite");
  const completed = waitForTransaction(transaction);
  if (record) transaction.objectStore(DATA_STORE).put(record, DATA_RECORD);
  else transaction.objectStore(DATA_STORE).delete(DATA_RECORD);
  await completed;
}

async function loadPersistentBase() {
  try {
    const stored = await readStoredBase();
    if (stored) {
      removeLegacyBase();
      return normalizeSavedBase(stored);
    }
    const legacy = readLegacyBase();
    if (!legacy) return emptyBase();
    // Migra a base antiga do localStorage uma única vez.
    const base = normalizeSavedBase(legacy);
    await writeStoredBase(serializableBase(base));
    removeLegacyBase();
    return base;
  } catch (error) {
    indexedStorageAvailable = false;
    console.warn("IndexedDB indisponível; usando o armazenamento simples do navegador.", error);
    return normalizeSavedBase(readLegacyBase());
  }
}

function serializableBase(base) {
  return {
    certificates: base.certificates || [],
    sources: base.sources || [],
    tasks: base.tasks || state.tasks || [],
    updatedAt: base.updatedAt || null,
    changedAt: base.changedAt || new Date().toISOString()
  };
}

function requestPersistentStorage() {
  if (persistentStorageRequested || !navigator.storage?.persist) return;
  persistentStorageRequested = true;
  navigator.storage.persisted()
    .then(persisted => persisted || navigator.storage.persist())
    .catch(() => {});
}

function normalizeSavedTask(task) {
  if (!task || !task.id || !task.title || !isValidIsoDate(task.dueDate)) return null;
  return {
    id: String(task.id),
    title: String(task.title).slice(0, 120),
    dueDate: task.dueDate,
    notes: String(task.notes || "").slice(0, 500),
    certificateKey: String(task.certificateKey || ""),
    status: task.status === "done" ? "done" : "pending",
    createdAt: task.createdAt || new Date().toISOString(),
    completedAt: task.status === "done" ? task.completedAt || new Date().toISOString() : null
  };
}

async function savePersistentBase(base = state) {
  const record = serializableBase(base);
  try {
    if (indexedStorageAvailable) await writeStoredBase(record);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch (error) {
    if (error?.name === "QuotaExceededError") {
      throw new Error("Não há espaço suficiente neste navegador para salvar a base. Libere espaço ou use uma versão atual do Chrome, Edge, Firefox ou Safari.");
    }
    throw error;
  }
  requestPersistentStorage();
  scheduleDailyPushSync();
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

function supportsPageNotifications() {
  return typeof Notification === "function";
}

function supportsServiceWorkerNotifications() {
  return "serviceWorker" in navigator
    && "ServiceWorkerRegistration" in window
    && typeof ServiceWorkerRegistration.prototype.showNotification === "function";
}

function supportsSystemNotifications() {
  return supportsPageNotifications();
}

function dailyPushIsConfigured() {
  try {
    const url = new URL(pushConfig.apiBaseUrl);
    const secureEnough = url.protocol === "https:" || ["localhost", "127.0.0.1"].includes(url.hostname);
    return secureEnough && pushConfig.vapidPublicKey.length > 40;
  } catch {
    return false;
  }
}

function supportsWebPush() {
  return supportsServiceWorkerNotifications()
    && "PushManager" in window
    && location.protocol !== "file:";
}

function getPushDeviceSecret(create = false) {
  let secret = localStorage.getItem(PUSH_DEVICE_KEY) || "";
  if (!secret && create) {
    const bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);
    secret = `device_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    localStorage.setItem(PUSH_DEVICE_KEY, secret);
  }
  return secret;
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

// Agrupa por tipo e data para manter o envio pequeno mesmo com dezenas de milhares de CAs.
function buildDailyReminderSnapshot(certificates, tasks) {
  const counts = new Map();
  const add = (kind, dueDate) => {
    const key = `${kind}|${dueDate}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  certificates.forEach(item => { if (isValidIsoDate(item.expiry)) add("certificate", item.expiry); });
  tasks.forEach(task => { if (task.status !== "done" && isValidIsoDate(task.dueDate)) add("task", task.dueDate); });
  return [...counts].map(([key, count]) => {
    const [kind, dueDate] = key.split("|");
    return { kind, dueDate, count };
  });
}

function dailyReminderSnapshot() {
  return buildDailyReminderSnapshot(state.certificates, state.tasks);
}

async function pushApiRequest(path, options = {}) {
  const { secret: suppliedSecret, ...requestOptions } = options;
  const secret = suppliedSecret || getPushDeviceSecret();
  if (!dailyPushIsConfigured()) throw new Error("O serviço de notificações diárias ainda não foi publicado.");
  if (!secret) throw new Error("Este aparelho ainda não foi registrado para notificações diárias.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${pushConfig.apiBaseUrl}${path}`, {
      ...requestOptions,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
        ...(requestOptions.headers || {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "O serviço de notificações não respondeu corretamente.");
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleDailyPushSync() {
  if (!dailyPushIsConfigured() || !getPushDeviceSecret() || !supportsSystemNotifications() || Notification.permission !== "granted") return;
  clearTimeout(dailyPushSyncTimer);
  dailyPushSyncTimer = setTimeout(() => {
    syncDailyPush().catch(error => console.warn("Não foi possível atualizar os alertas diários.", error));
  }, 900);
}

function dailyPushTimeLabel() {
  const [hour, minute] = dailyPushTime.split(":");
  return minute && minute !== "00" ? `${Number(hour)}h${minute}` : `${Number(hour)}h`;
}

async function syncDailyPush({ allowSubscribe = false } = {}) {
  if (!state.loaded) return false;
  if (!dailyPushIsConfigured() || !supportsWebPush() || !supportsSystemNotifications() || Notification.permission !== "granted") return false;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration?.pushManager) return false;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription && allowSubscribe) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(pushConfig.vapidPublicKey)
    });
  }
  if (!subscription) return false;
  const secret = getPushDeviceSecret(true);
  const result = await pushApiRequest("/api/devices/me", {
    method: "PUT",
    secret,
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      reminders: dailyReminderSnapshot(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo",
      appUrl: new URL(".", location.href).href
    })
  });
  if (/^\d{2}:\d{2}$/.test(result?.dailyAt || "")) dailyPushTime = result.dailyAt;
  dailyPushActive = true;
  updateNotificationSetup();
  return true;
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

// Datas ISO (AAAA-MM-DD) ordenam corretamente como texto, sem criar objetos Date.
function compareExpiry(a, b) {
  return a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0;
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

function taskStatus(task) {
  if (task.status === "done") return { key: "done", label: "Concluída" };
  const days = daysUntil(task.dueDate);
  if (days < 0) return { key: "overdue", label: `${Math.abs(days)} ${Math.abs(days) === 1 ? "dia" : "dias"} em atraso` };
  if (days === 0) return { key: "today", label: "Vence hoje" };
  if (days === 1) return { key: "upcoming", label: "Amanhã" };
  return { key: "upcoming", label: `${days} dias` };
}

function taskCertificate(task) {
  return state.certificates.find(item => certificateKey(item) === task.certificateKey) || null;
}

function taskReminderItems() {
  return state.tasks
    .filter(task => task.status !== "done" && daysUntil(task.dueDate) <= 7)
    .sort((a, b) => localDate(a.dueDate) - localDate(b.dueDate));
}

function renderTasks() {
  const tasks = [...state.tasks].sort((a, b) => {
    if ((a.status === "done") !== (b.status === "done")) return a.status === "done" ? 1 : -1;
    return localDate(a.dueDate) - localDate(b.dueDate);
  });
  const pending = tasks.filter(task => task.status !== "done");
  const overdue = pending.filter(task => daysUntil(task.dueDate) < 0).length;
  els.taskBadge.textContent = pending.length > 99 ? "99+" : String(pending.length);
  els.taskBadge.hidden = pending.length === 0;
  els.tasksButton.setAttribute("aria-label", pending.length
    ? `Abrir acompanhamento, ${pending.length} ${pending.length === 1 ? "tarefa pendente" : "tarefas pendentes"}`
    : "Abrir acompanhamento");
  document.querySelector("#taskSummary").textContent = pending.length
    ? `${pending.length} pendente(s)${overdue ? ` · ${overdue} atrasada(s)` : ""}`
    : "Nenhuma tarefa pendente.";
  els.tasksEmpty.hidden = tasks.length > 0;
  els.taskList.hidden = tasks.length === 0;
  els.taskList.innerHTML = tasks.map(task => {
    const status = taskStatus(task);
    const certificate = taskCertificate(task);
    const context = certificate ? `${certificate.company} · ${certificateDisplay(certificate).code}` : "Tarefa geral";
    const notes = task.notes ? ` · ${task.notes}` : "";
    return `<article class="task-item ${task.status === "done" ? "done" : ""}">
      <button class="task-check" type="button" data-task-toggle="${escapeHtml(task.id)}" aria-label="${task.status === "done" ? "Reabrir" : "Concluir"} ${escapeHtml(task.title)}">✓</button>
      <div class="task-copy"><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(context + notes)}</p></div>
      <div class="task-actions"><span class="task-due ${status.key}">${escapeHtml(status.label)} · ${formatDate(task.dueDate)}</span><button type="button" data-task-edit="${escapeHtml(task.id)}" aria-label="Editar tarefa">✎</button><button type="button" data-task-delete="${escapeHtml(task.id)}" aria-label="Excluir tarefa">×</button></div>
    </article>`;
  }).join("");
}

function makeId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function openTasksManager() {
  if (els.tasksManagerDialog.open) return;
  if (typeof els.tasksManagerDialog.showModal === "function") els.tasksManagerDialog.showModal();
  else els.tasksManagerDialog.setAttribute("open", "");
  els.tasksButton.setAttribute("aria-expanded", "true");
}

function closeTasksManager() {
  if (!els.tasksManagerDialog.hasAttribute("open")) return;
  if (typeof els.tasksManagerDialog.close === "function") els.tasksManagerDialog.close();
  else els.tasksManagerDialog.removeAttribute("open");
  els.tasksButton.setAttribute("aria-expanded", "false");
}

function openHashTarget() {
  if (location.hash === "#tarefas") openTasksManager();
}

function openTaskDialog(task = null) {
  document.querySelector("#taskDialogTitle").textContent = task ? "Editar tarefa" : "Nova tarefa";
  document.querySelector("#taskId").value = task?.id || "";
  document.querySelector("#taskTitle").value = task?.title || "";
  document.querySelector("#taskDueDate").value = task?.dueDate || new Date().toLocaleDateString("en-CA");
  document.querySelector("#taskNotes").value = task?.notes || "";
  const collator = new Intl.Collator("pt-BR");
  els.taskCertificate.innerHTML = `<option value="">Nenhum certificado</option>${state.certificates
    .slice().sort((a, b) => collator.compare(a.company, b.company))
    .map(item => `<option value="${escapeHtml(certificateKey(item))}">${escapeHtml(`${item.company} · ${certificateDisplay(item).code}`)}</option>`).join("")}`;
  els.taskCertificate.value = task?.certificateKey || "";
  if (typeof els.taskDialog.showModal === "function") els.taskDialog.showModal();
  else els.taskDialog.setAttribute("open", "");
  setTimeout(() => document.querySelector("#taskTitle").focus(), 0);
}

function closeTaskDialog() {
  if (typeof els.taskDialog.close === "function") els.taskDialog.close();
  else els.taskDialog.removeAttribute("open");
}

async function persistTaskChange(message) {
  state.changedAt = new Date().toISOString();
  render();
  try {
    await savePersistentBase();
    showToast("Tarefas atualizadas", message);
  } catch (error) {
    showToast("Tarefa não salva", error.message || "Não foi possível salvar a alteração neste navegador.", true);
  }
  safelyCheckExpiringNotifications();
}

function filteredCertificates() {
  const query = state.query.trim().toLocaleLowerCase("pt-BR");
  return state.certificates
    .filter(item => state.filter === "todos" || getStatus(item).key === state.filter)
    .filter(item => !query || searchableCertificateText(item).toLocaleLowerCase("pt-BR").includes(query))
    .sort(compareExpiry);
}

function render() {
  if (!state.loaded) return;
  const hasData = state.certificates.length > 0 || state.tasks.length > 0;
  updateInstallExperience();
  els.uploadState.hidden = hasData;
  els.dataView.hidden = !hasData;
  els.tasksButton.hidden = !hasData;
  els.notificationButton.hidden = !hasData;
  document.querySelector("#importButtonLabel").textContent = supportsLinkedFiles()
    ? (hasData ? "Vincular outro XLSX" : "Vincular XLSX")
    : (hasData ? "Adicionar XLSX" : "Importar XLSX");
  els.selectFileLabel.textContent = supportsLinkedFiles() ? "Vincular XLSX" : "Selecionar XLSX";
  updateFileSyncStatus();
  if (!hasData) {
    closeNotificationPanel();
    closeTasksManager();
    return;
  }

  const filtered = filteredCertificates();
  // Desenhar dezenas de milhares de linhas trava a página; mostramos em blocos.
  const visible = filtered.slice(0, state.visibleRows);
  const indexByItem = new Map(state.certificates.map((item, index) => [item, index]));
  els.rows.innerHTML = visible.map((item) => {
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
  document.querySelector("#paginationText").textContent = filtered.length === state.certificates.length
    ? `Mostrando ${visible.length} de ${filtered.length} registros`
    : `Mostrando ${visible.length} de ${filtered.length} registros (base com ${state.certificates.length})`;
  const hiddenRows = filtered.length - visible.length;
  els.showMoreButton.hidden = hiddenRows <= 0;
  els.showMoreButton.textContent = `Mostrar mais ${Math.min(ROWS_PAGE_SIZE, hiddenRows)}`;
  const sourceLabel = state.sources.length === 0
    ? "Nenhuma planilha importada"
    : state.sources.length === 1 ? state.sources[0].name : `${state.sources.length} planilhas combinadas`;
  document.querySelector("#currentFileName").textContent = sourceLabel;
  document.querySelector("#currentFileName").title = state.sources.map(source => source.name).join(", ");
  document.querySelector("#lastUpdated").textContent = state.updatedAt
    ? `Atualizada em ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(state.updatedAt))}`
    : "Base restaurada";
  renderStats();
  renderTasks();
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
  const totalAlerts = priorities + taskReminderItems().length;
  document.querySelector("#notificationDot").hidden = totalAlerts === 0;
  updateAppBadge(totalAlerts);
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
  const urgent = state.certificates.filter(item => ["vencido", "urgente", "atencao"].includes(getStatus(item).key)).sort(compareExpiry);
  const taskReminders = taskReminderItems();
  document.querySelector("#alertCount").textContent = urgent.length + taskReminders.length;
  const hiddenAlerts = urgent.length - NOTIFICATION_PANEL_LIMIT;
  const moreHtml = hiddenAlerts > 0
    ? `<div class="notification-empty">E mais ${hiddenAlerts} certificado(s). Use os filtros do painel para ver todos.</div>`
    : "";
  const certificateHtml = urgent.slice(0, NOTIFICATION_PANEL_LIMIT).map(item => {
    const status = getStatus(item);
    const certificate = certificateDisplay(item);
    return `<div class="notification-item"><span class="notification-symbol ${status.key}">${status.key === "vencido" ? "!" : "◷"}</span><div><strong>${escapeHtml(item.company)}</strong><p>${escapeHtml(certificate.code)} · ${status.key === "vencido" ? "está vencido" : `vence em ${daysUntil(item.expiry)} dias`} · ${formatDate(item.expiry)}</p></div></div>`;
  }).join("");
  const taskHtml = taskReminders.map(task => {
    const status = taskStatus(task);
    return `<div class="notification-item"><span class="notification-symbol ${status.key === "overdue" ? "vencido" : "urgente"}">✓</span><div><strong>${escapeHtml(task.title)}</strong><p>Tarefa · ${escapeHtml(status.label)} · ${formatDate(task.dueDate)}</p></div></div>`;
  }).join("");
  els.notifications.innerHTML = certificateHtml + moreHtml + taskHtml || `<div class="notification-empty">Tudo certo por aqui. Nenhum CA ou tarefa requer atenção.</div>`;
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
    if (dailyPushActive) {
      title.textContent = "Notificações diárias ativadas";
      text.textContent = `Um resumo será enviado diariamente a partir das ${dailyPushTimeLabel()} quando houver certificados ou tarefas que precisem de atenção.`;
      els.enableNotificationsButton.textContent = "Testar aviso";
    } else if (dailyPushIsConfigured() && supportsWebPush()) {
      title.textContent = "Conclua a ativação dos avisos diários";
      text.textContent = "Toque ao lado para registrar este aparelho e receber alertas mesmo com o app fechado.";
      els.enableNotificationsButton.textContent = "Ativar diário";
    } else {
      title.textContent = "Notificações locais ativadas";
      text.textContent = "Os avisos são verificados ao abrir o app. O serviço diário ainda precisa ser publicado.";
      els.enableNotificationsButton.textContent = "Testar aviso";
    }
  } else if (Notification.permission === "denied") {
    els.notificationSetup.classList.add("blocked");
    title.textContent = "Notificações bloqueadas";
    text.textContent = "Libere as notificações nas configurações do navegador para receber os avisos.";
    els.enableNotificationsButton.textContent = "Bloqueadas";
    els.enableNotificationsButton.disabled = true;
  } else {
    title.textContent = "Ative os avisos de vencimento";
    text.textContent = dailyPushIsConfigured()
      ? `Receba diariamente um resumo de CAs e tarefas, mesmo com o app fechado.`
      : `Receba uma notificação para CAs vencidos ou que vencem nos próximos ${RENEWAL_MONTHS} meses.`;
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
  if (supportsServiceWorkerNotifications() && !swRegistrationFailed && location.protocol !== "file:") {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration && typeof registration.showNotification === "function") {
        await registration.showNotification(title, notificationOptions);
        return;
      }
    } catch (error) {
      console.warn("Não foi possível exibir a notificação pelo service worker; usando o modo da página.", error);
    }
  }
  if (supportsPageNotifications()) {
    new Notification(title, notificationOptions);
    return;
  }
  throw new Error("Notificações do sistema indisponíveis.");
}

async function requestNotifications() {
  if (!supportsSystemNotifications()) return;
  try {
    if (Notification.permission === "granted") {
      await syncDailyPush({ allowSubscribe: true }).catch(error => {
        console.warn("Não foi possível ativar as notificações diárias.", error);
        showToast("Aviso diário não conectado", error.message, true);
      });
      await showBrowserNotification("CA Alerta está ativo", { body: "Os avisos de vencimento estão funcionando.", tag: "ca-alerta-teste" });
      return;
    }
    const permission = await Notification.requestPermission();
    updateNotificationSetup();
    if (permission === "granted") {
      showToast("Notificações ativadas", "Você receberá avisos sobre os CAs prioritários.");
      await syncDailyPush({ allowSubscribe: true }).catch(error => {
        console.warn("Não foi possível ativar as notificações diárias.", error);
        showToast("Aviso diário não conectado", error.message, true);
      });
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
  if (!state.loaded || !supportsSystemNotifications() || Notification.permission !== "granted") return;
  const urgent = state.certificates
    .filter(item => ["vencido", "urgente", "atencao"].includes(getStatus(item).key))
    .sort(compareExpiry);
  const taskReminders = taskReminderItems();
  if (!urgent.length && !taskReminders.length) return;

  const todayKey = new Date().toLocaleDateString("en-CA");
  let notified = {};
  try { notified = JSON.parse(localStorage.getItem(NOTIFIED_KEY)) || {}; } catch { notified = {}; }
  const signature = [
    ...urgent.map(item => `ca|${certificateKey(item)}|${item.expiry}|${getStatus(item).key}`),
    ...taskReminders.map(task => `task|${task.id}|${task.dueDate}|${task.status}`)
  ].join(";");
  let signatureHash = 0;
  for (let index = 0; index < signature.length; index++) signatureHash = (signatureHash * 31 + signature.charCodeAt(index)) >>> 0;
  const recordKey = `summary|${todayKey}|${signatureHash.toString(36)}`;
  if (notified[recordKey]) return;

  const counts = { vencido: 0, urgente: 0, atencao: 0 };
  urgent.forEach(item => counts[getStatus(item).key]++);
  const total = urgent.length + taskReminders.length;
  const title = taskReminders.length
    ? `${total} ${total === 1 ? "item precisa" : "itens precisam"} de acompanhamento`
    : `${urgent.length} ${urgent.length === 1 ? "CA precisa" : "CAs precisam"} de acompanhamento`;
  const taskText = taskReminders.length ? ` ${taskReminders.length} tarefa(s) vencem em até 7 dias ou estão atrasadas.` : "";
  await showBrowserNotification(title, {
    body: `${counts.vencido} CA(s) vencido(s), ${counts.urgente} em até 30 dias e ${counts.atencao} na janela de ${RENEWAL_MONTHS} meses.${taskText}`,
    tag: `ca-alerta-resumo-${todayKey}`,
    data: { url: location.href.split("#")[0] + (taskReminders.length ? "#tarefas" : "#certificados") }
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
  state.visibleRows = ROWS_PAGE_SIZE;
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
  if (entries === 0xffff || centralOffset === 0xffffffff) {
    throw new Error("Planilha grande demais para leitura (formato ZIP64). Divida a planilha em arquivos menores.");
  }
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
    if (!/\.(xml|rels)$/i.test(name)) {
      // Imagens e outros anexos não são necessários para ler os dados.
      cursor += 46 + nameLength + extraLength + commentLength;
      continue;
    }
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

function columnName(index) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + (value - 1) % 26) + name;
  }
  return name;
}

function columnIndex(name) {
  return [...name].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function readSheetRows(xml, sharedStrings) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return [...doc.querySelectorAll("sheetData row")].map((row, position) => {
    const result = {};
    const cellTypes = {};
    let nextColumn = 0;
    [...row.querySelectorAll(":scope > c")].forEach(cell => {
      // Alguns geradores de XLSX omitem a referência "r"; nesse caso a célula segue a anterior.
      const reference = String(cell.getAttribute("r") || "").replace(/\d/g, "").toUpperCase();
      const column = reference || columnName(nextColumn);
      nextColumn = columnIndex(column) + 1;
      const type = cell.getAttribute("t") || "n";
      const inline = [...cell.querySelectorAll("is t")].map(node => node.textContent).join("");
      const raw = cell.querySelector("v")?.textContent ?? inline;
      result[column] = type === "s" ? sharedStrings[Number(raw)] ?? "" : raw;
      cellTypes[column] = type;
    });
    Object.defineProperties(result, {
      __rowNumber: { value: Number(row.getAttribute("r")) || position + 1 },
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

function bestHeaderIndex(rows) {
  let best = { index: -1, score: -1 };
  rows.slice(0, 30).forEach((row, index) => {
    const detected = detectColumns(row);
    const populated = Object.values(row).filter(value => String(value ?? "").trim()).length;
    const score = Object.values(detected).filter(Boolean).length * 3
      + (detected.cnpj ? 5 : 0)
      + (detected.company ? 5 : 0)
      + (detected.expiry ? 5 : 0)
      + Math.min(populated, 6);
    if (score > best.score) best = { index, score };
  });
  return best.index;
}

function mappingIsUsable(rows, mapping) {
  if (!mapping || !Number.isInteger(mapping.headerIndex) || !rows[mapping.headerIndex]) return false;
  const columns = mapping.columns || {};
  return [columns.cnpj, columns.company, columns.expiry].every(column => column && Object.hasOwn(rows[mapping.headerIndex], column));
}

function mappingColumnOptions(header, selected = "", optional = false) {
  const options = Object.keys(header)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(column => `<option value="${escapeHtml(column)}" ${column === selected ? "selected" : ""}>${escapeHtml(`${column} — ${String(header[column] || "(sem título)").trim()}`)}</option>`)
    .join("");
  return `<option value="">${optional ? "Não importar" : "Selecione uma coluna"}</option>${options}`;
}

function populateColumnMappingFields(headerIndex, preferredColumns = {}) {
  if (!pendingColumnMapping) return;
  const header = pendingColumnMapping.rows[headerIndex] || {};
  const detected = detectColumns(header);
  const selections = { ...detected, ...preferredColumns };
  const fields = [
    ["mappingCnpj", "cnpj", false],
    ["mappingCompany", "company", false],
    ["mappingExpiry", "expiry", false],
    ["mappingRegistration", "registration", true],
    ["mappingReference", "reference", true],
    ["mappingCnae", "cnae", true]
  ];
  fields.forEach(([id, key, optional]) => {
    document.querySelector(`#${id}`).innerHTML = mappingColumnOptions(header, selections[key], optional);
  });
}

function requestColumnMapping(rows, suggestedHeaderIndex = bestHeaderIndex(rows), suggestedColumns = {}) {
  return new Promise((resolve, reject) => {
    pendingColumnMapping = { rows, resolve, reject };
    const headerRows = rows.slice(0, 30)
      .map((row, index) => ({ index, values: Object.values(row).filter(value => String(value ?? "").trim()).slice(0, 4) }))
      .filter(item => item.values.length);
    const headerSelect = document.querySelector("#mappingHeaderRow");
    headerSelect.innerHTML = headerRows.map(item => `<option value="${item.index}" ${item.index === suggestedHeaderIndex ? "selected" : ""}>Linha ${item.index + 1} — ${escapeHtml(item.values.join(" · "))}</option>`).join("");
    const selectedIndex = Number(headerSelect.value || suggestedHeaderIndex || 0);
    populateColumnMappingFields(selectedIndex, suggestedColumns);
    if (typeof els.columnMappingDialog.showModal === "function") els.columnMappingDialog.showModal();
    else els.columnMappingDialog.setAttribute("open", "");
  });
}

function closeColumnMappingDialog(cancel = true) {
  if (typeof els.columnMappingDialog.close === "function") els.columnMappingDialog.close();
  else els.columnMappingDialog.removeAttribute("open");
  if (cancel && pendingColumnMapping) {
    const error = new Error("Importação cancelada.");
    error.name = "AbortError";
    pendingColumnMapping.reject(error);
  }
  pendingColumnMapping = null;
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

async function parseXlsx(file, options = {}) {
  const files = await unzipXlsx(await file.arrayBuffer());
  const sharedDoc = new DOMParser().parseFromString(files.get("xl/sharedStrings.xml") || "<sst/>", "application/xml");
  const shared = [...sharedDoc.querySelectorAll("si")].map(si => [...si.querySelectorAll("t")].map(t => t.textContent).join(""));
  const { date1904, sheetName } = workbookInfo(files);
  if (!sheetName) throw new Error("Nenhuma aba de dados foi encontrada.");
  const rows = readSheetRows(files.get(sheetName), shared);
  if (!rows.length) throw new Error("A primeira aba da planilha está vazia.");

  let headerIndex = mappingIsUsable(rows, options.mapping) ? options.mapping.headerIndex : bestHeaderIndex(rows);
  if (headerIndex < 0) headerIndex = 0;
  let cols = mappingIsUsable(rows, options.mapping) ? options.mapping.columns : detectColumns(rows[headerIndex]);
  if (options.forceMapping || !cols.cnpj || !cols.company || !cols.expiry) {
    if (options.automatic) {
      throw new Error("As colunas mudaram. Importe a planilha manualmente para refazer o mapeamento.");
    }
    const mapping = await requestColumnMapping(rows, headerIndex, cols);
    headerIndex = mapping.headerIndex;
    cols = mapping.columns;
  }
  const parsed = parseCertificateRows(rows, cols, date1904, headerIndex);
  return { ...parsed, mapping: { headerIndex, columns: cols } };
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
  if (!state.loaded) {
    showToast("Aguarde um instante", "A base salva ainda está sendo carregada.", true);
    return false;
  }
  try {
    const source = state.sources.find(item => item.name === file.name);
    const { certificates: imported, rejected, mapping } = await parseXlsx(file, {
      mapping: source?.mapping,
      automatic: Boolean(options.automatic),
      forceMapping: Boolean(options.forceMapping)
    });
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
    const changedAt = importedAt;
    sources[sources.length - 1].mapping = mapping;
    await savePersistentBase({ certificates: merged.certificates, sources, tasks: state.tasks, updatedAt: importedAt, changedAt });
    state.certificates = merged.certificates;
    state.sources = sources;
    state.updatedAt = importedAt;
    state.changedAt = changedAt;
    state.filter = "todos";
    state.query = "";
    state.visibleRows = ROWS_PAGE_SIZE;
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
    if (error?.name === "AbortError") return false;
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
  if (!state.loaded || fileSyncInProgress || !linkedFileHandles.size || document.visibilityState === "hidden") return 0;
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
els.search.addEventListener("input", event => {
  const value = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = value;
    state.visibleRows = ROWS_PAGE_SIZE;
    render();
  }, 150);
});
els.filter.addEventListener("change", event => {
  state.filter = event.target.value;
  state.visibleRows = ROWS_PAGE_SIZE;
  render();
});
els.showMoreButton.addEventListener("click", () => {
  state.visibleRows += ROWS_PAGE_SIZE;
  render();
});
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
els.tasksButton.addEventListener("click", openTasksManager);
document.querySelector("#closeTasksManagerDialog").addEventListener("click", closeTasksManager);
els.tasksManagerDialog.addEventListener("close", () => els.tasksButton.setAttribute("aria-expanded", "false"));
els.tasksManagerDialog.addEventListener("click", event => {
  if (event.target === els.tasksManagerDialog) closeTasksManager();
});
document.querySelector("#newTaskButton").addEventListener("click", () => openTaskDialog());
document.querySelector("#emptyTaskButton").addEventListener("click", () => openTaskDialog());
document.querySelector("#closeTaskDialog").addEventListener("click", closeTaskDialog);
document.querySelector("#cancelTaskButton").addEventListener("click", closeTaskDialog);
document.querySelector("#mappingHeaderRow").addEventListener("change", event => {
  populateColumnMappingFields(Number(event.target.value));
});
document.querySelector("#closeColumnMappingDialog").addEventListener("click", () => closeColumnMappingDialog(true));
document.querySelector("#cancelColumnMappingButton").addEventListener("click", () => closeColumnMappingDialog(true));
els.columnMappingDialog.addEventListener("cancel", event => {
  event.preventDefault();
  closeColumnMappingDialog(true);
});
els.columnMappingForm.addEventListener("submit", event => {
  event.preventDefault();
  if (!pendingColumnMapping) return;
  const mapping = {
    headerIndex: Number(document.querySelector("#mappingHeaderRow").value),
    columns: {
      cnpj: document.querySelector("#mappingCnpj").value,
      company: document.querySelector("#mappingCompany").value,
      expiry: document.querySelector("#mappingExpiry").value,
      registration: document.querySelector("#mappingRegistration").value || undefined,
      reference: document.querySelector("#mappingReference").value || undefined,
      cnae: document.querySelector("#mappingCnae").value || undefined
    }
  };
  if (!mapping.columns.cnpj || !mapping.columns.company || !mapping.columns.expiry) {
    showToast("Mapeamento incompleto", "Selecione CNPJ, Razão Social e Data de Validade.", true);
    return;
  }
  const resolve = pendingColumnMapping.resolve;
  closeColumnMappingDialog(false);
  resolve(mapping);
});
els.taskForm.addEventListener("submit", event => {
  event.preventDefault();
  const id = document.querySelector("#taskId").value;
  const existing = state.tasks.find(task => task.id === id);
  const task = normalizeSavedTask({
    id: id || makeId(),
    title: document.querySelector("#taskTitle").value.trim(),
    dueDate: document.querySelector("#taskDueDate").value,
    certificateKey: els.taskCertificate.value,
    notes: document.querySelector("#taskNotes").value.trim(),
    status: existing?.status || "pending",
    createdAt: existing?.createdAt || new Date().toISOString(),
    completedAt: existing?.completedAt || null
  });
  if (!task) {
    showToast("Tarefa incompleta", "Informe um título e uma data de prazo válida.", true);
    return;
  }
  state.tasks = existing ? state.tasks.map(item => item.id === id ? task : item) : [...state.tasks, task];
  closeTaskDialog();
  persistTaskChange(existing ? "A tarefa foi atualizada." : "O novo lembrete foi criado.");
  if (!existing) openTasksManager();
});
els.taskList.addEventListener("click", event => {
  const toggle = event.target.closest("[data-task-toggle]");
  const edit = event.target.closest("[data-task-edit]");
  const remove = event.target.closest("[data-task-delete]");
  if (toggle) {
    const now = new Date().toISOString();
    state.tasks = state.tasks.map(task => task.id === toggle.dataset.taskToggle
      ? { ...task, status: task.status === "done" ? "pending" : "done", completedAt: task.status === "done" ? null : now }
      : task);
    persistTaskChange("O status da tarefa foi alterado.");
  } else if (edit) {
    const task = state.tasks.find(item => item.id === edit.dataset.taskEdit);
    if (task) openTaskDialog(task);
  } else if (remove) {
    const task = state.tasks.find(item => item.id === remove.dataset.taskDelete);
    if (task && window.confirm(`Excluir a tarefa “${task.title}”?`)) {
      state.tasks = state.tasks.filter(item => item.id !== task.id);
      persistTaskChange("A tarefa foi excluída.");
    }
  }
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
  if (!window.confirm("Deseja apagar todas as planilhas, certificados e tarefas salvos neste navegador?")) return;
  try {
    if (indexedStorageAvailable) await writeStoredBase(null);
  } catch (error) {
    console.warn("Não foi possível apagar a base do IndexedDB.", error);
  }
  removeLegacyBase();
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
  state.tasks = [];
  state.updatedAt = null;
  state.changedAt = new Date().toISOString();
  state.query = "";
  state.filter = "todos";
  state.visibleRows = ROWS_PAGE_SIZE;
  els.search.value = "";
  els.filter.value = "todos";
  render();
  scheduleDailyPushSync();
  showToast("Base removida", "Planilhas, certificados e tarefas foram removidos deste navegador.");
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
window.addEventListener("hashchange", openHashTarget);

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js")
    .then(() => {
      swRegistrationFailed = false;
      updateNotificationSetup();
      syncDailyPush().catch(error => console.warn("Não foi possível restaurar os alertas diários.", error));
    })
    .catch(error => {
      swRegistrationFailed = true;
      console.warn("Não foi possível registrar o service worker; notificações usarão o modo da página.", error);
      updateNotificationSetup();
    });
}

async function startApp() {
  Object.assign(state, await loadPersistentBase());
  state.loaded = true;
  render();
  openHashTarget();
  initializeLinkedFiles();
  setTimeout(() => syncDailyPush().catch(() => {}), 900);
  setTimeout(safelyCheckExpiringNotifications, 1200);
  setInterval(safelyCheckExpiringNotifications, 6 * 60 * 60 * 1000);
}

startApp();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    safelyCheckExpiringNotifications();
    checkLinkedFiles();
    syncDailyPush().catch(() => {});
  }
});
