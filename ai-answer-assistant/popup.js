// DOM Elements
const statusBadge = document.getElementById("statusBadge");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const questionCount = document.getElementById("questionCount");
const answeredCount = document.getElementById("answeredCount");

const scanBtn = document.getElementById("scanBtn");
const startBtn = document.getElementById("startBtn");
const startBtnText = document.getElementById("startBtnText");

// Settings Modal Elements
const settingsModal = document.getElementById("settingsModal");
const openSettingsBtn = document.getElementById("openSettingsBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const closeSettingsBackdrop = document.getElementById("closeSettingsBackdrop");
const modelList = document.getElementById("modelList");
const addModelBtn = document.getElementById("addModelBtn");

// Edit Model Modal Elements
const editModelModal = document.getElementById("editModelModal");
const closeEditBtn = document.getElementById("closeEditBtn");
const closeEditBackdrop = document.getElementById("closeEditBackdrop");
const editModalTitle = document.getElementById("editModalTitle");
const editNameInput = document.getElementById("editName");
const editBaseUrlInput = document.getElementById("editBaseUrl");
const editApiKeyInput = document.getElementById("editApiKey");
const editModelInput = document.getElementById("editModel");
const editStatus = document.getElementById("editStatus");
const saveModelBtn = document.getElementById("saveModelBtn");
const toggleEditApiKeyBtn = document.getElementById("toggleEditApiKey");

let editingModelId = null;

const logContent = document.getElementById("logContent");
const clearLogBtn = document.getElementById("clearLog");

// State
let isRunning = false;
let hasScanned = false;

// Built-in default model
const BUILTIN_MODEL = {
  id: "builtin-default",
  name: "默认",
  baseUrl: "https://d.yikfun.de5.net/",
  apiKey: "default",
  model: "Doubao-1.5-pro",
  builtin: true,
};

// Initialize
document.addEventListener("DOMContentLoaded", async () => {
  await initModels();

  // Check active session
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]) {
    chrome.tabs.sendMessage(tabs[0].id, { action: "getStatus" }, (response) => {
      if (chrome.runtime.lastError) return;

      if (response) {
        questionCount.textContent = response.questionCount || 0;
        answeredCount.textContent = response.answeredCount || 0;

        if (response.isRunning) {
          setRunningState(true);
          addLog("info", "检测到正在运行的任务");
        } else if (response.questionCount > 0) {
          hasScanned = true;
          startBtn.disabled = false;
          addLog("info", "检测到已扫描题目，可以开始");
        }
      }
    });
  }
});

// --- Modal Logic ---
function openModal() {
  settingsModal.classList.add("open");
  renderModelList();
}

function closeModal() {
  settingsModal.classList.remove("open");
}

function openEditModal(modelId = null) {
  editingModelId = modelId;
  editModelModal.classList.add("open");

  if (modelId) {
    editModalTitle.textContent = "编辑模型";
    loadModelForEdit(modelId);
  } else {
    editModalTitle.textContent = "添加模型";
    editNameInput.value = "";
    editBaseUrlInput.value = "https://api.openai.com/v1";
    editApiKeyInput.value = "";
    editModelInput.value = "";
  }
}

function closeEditModal() {
  editModelModal.classList.remove("open");
  editingModelId = null;
}

openSettingsBtn.addEventListener("click", openModal);
closeSettingsBtn.addEventListener("click", closeModal);
closeSettingsBackdrop.addEventListener("click", closeModal);
addModelBtn.addEventListener("click", () => openEditModal());
closeEditBtn.addEventListener("click", closeEditModal);
closeEditBackdrop.addEventListener("click", closeEditModal);

// --- Template Management ---
const openTemplatesBtn = document.getElementById("openTemplatesBtn");
openTemplatesBtn.addEventListener("click", () => {
  window.location.href = "template-manager.html";
});

// --- Model Management Logic ---
toggleEditApiKeyBtn.addEventListener("click", () => {
  const type = editApiKeyInput.type === "password" ? "text" : "password";
  editApiKeyInput.type = type;
  toggleEditApiKeyBtn.style.opacity = type === "text" ? "1" : "0.6";
});

async function initModels() {
  const data = await chrome.storage.sync.get([
    "aiModels",
    "activeModelId",
    "baseUrl",
    "apiKey",
    "model",
  ]);

  // Migrate old config to new structure
  if (!data.aiModels && data.apiKey) {
    const customModel = {
      id: "custom-" + Date.now(),
      name: "自定义模型",
      baseUrl: data.baseUrl || "https://api.openai.com/v1",
      apiKey: data.apiKey,
      model: data.model || "gpt-4o-mini",
      builtin: false,
    };
    await chrome.storage.sync.set({
      aiModels: [customModel],
      activeModelId: customModel.id,
    });
  } else if (!data.aiModels) {
    // First time, set builtin as active
    await chrome.storage.sync.set({
      aiModels: [],
      activeModelId: BUILTIN_MODEL.id,
    });
  }
}

async function getAllModels() {
  const data = await chrome.storage.sync.get(["aiModels"]);
  return [BUILTIN_MODEL, ...(data.aiModels || [])];
}

async function getActiveModel() {
  const data = await chrome.storage.sync.get(["activeModelId"]);
  const models = await getAllModels();
  const activeId = data.activeModelId || BUILTIN_MODEL.id;
  return models.find((m) => m.id === activeId) || BUILTIN_MODEL;
}

async function renderModelList() {
  const models = await getAllModels();
  const data = await chrome.storage.sync.get(["activeModelId"]);
  const activeId = data.activeModelId || BUILTIN_MODEL.id;

  modelList.innerHTML = models
    .map(
      (model) => `
    <div class="model-item ${
      model.id === activeId ? "active" : ""
    }" data-model-id="${model.id}">
      <input type="radio" name="activeModel" class="model-radio" value="${
        model.id
      }" ${model.id === activeId ? "checked" : ""}>
      <div class="model-info">
        <div class="model-name">
          ${model.name}
          ${model.builtin ? '<span class="model-badge">内置</span>' : ""}
        </div>
        <div class="model-meta">${model.model}</div>
      </div>
      <div class="model-actions">
        ${
          !model.builtin
            ? `
          <button class="icon-btn edit-model-btn" data-model-id="${model.id}">
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
          </button>
          <button class="icon-btn delete-model-btn" data-model-id="${model.id}">
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        `
            : ""
        }
      </div>
    </div>
  `
    )
    .join("");

  // Add click event to entire model card
  document.querySelectorAll(".model-item").forEach((item) => {
    item.addEventListener("click", async (e) => {
      // Don't trigger if clicking on action buttons
      if (
        e.target.closest(".edit-model-btn") ||
        e.target.closest(".delete-model-btn")
      ) {
        return;
      }

      const modelId = item.dataset.modelId;
      const model = models.find((m) => m.id === modelId);

      await chrome.storage.sync.set({ activeModelId: modelId });
      addLog("success", `已使用${model.name}模型`);
      closeModal();
    });
  });

  // Add event listeners for radio buttons
  document.querySelectorAll(".model-radio").forEach((radio) => {
    radio.addEventListener("change", async (e) => {
      e.stopPropagation();
      await chrome.storage.sync.set({ activeModelId: e.target.value });
      renderModelList();
    });
  });

  // Add event listeners for edit buttons
  document.querySelectorAll(".edit-model-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const modelId = e.currentTarget.dataset.modelId;
      openEditModal(modelId);
    });
  });

  // Add event listeners for delete buttons
  document.querySelectorAll(".delete-model-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const modelId = e.currentTarget.dataset.modelId;
      if (!confirm("确定要删除这个模型吗？")) return;

      const data = await chrome.storage.sync.get(["aiModels", "activeModelId"]);
      const models = (data.aiModels || []).filter((m) => m.id !== modelId);

      const updates = { aiModels: models };
      if (data.activeModelId === modelId) {
        updates.activeModelId = BUILTIN_MODEL.id;
      }

      await chrome.storage.sync.set(updates);
      renderModelList();
    });
  });
}

async function loadModelForEdit(modelId) {
  const models = await getAllModels();
  const model = models.find((m) => m.id === modelId);
  if (model) {
    editNameInput.value = model.name;
    editBaseUrlInput.value = model.baseUrl;
    editApiKeyInput.value = model.apiKey;
    editModelInput.value = model.model;
  }
}

saveModelBtn.addEventListener("click", async () => {
  const name = editNameInput.value.trim();
  const baseUrl = editBaseUrlInput.value.trim();
  const apiKey = editApiKeyInput.value.trim();
  const model = editModelInput.value.trim();

  if (!name || !baseUrl || !apiKey || !model) {
    showEditStatus("error", "请填写所有配置项");
    return;
  }

  saveModelBtn.disabled = true;
  saveModelBtn.textContent = "保存中...";

  const data = await chrome.storage.sync.get(["aiModels"]);
  const models = data.aiModels || [];

  if (editingModelId) {
    // Edit existing
    const index = models.findIndex((m) => m.id === editingModelId);
    if (index !== -1) {
      models[index] = { ...models[index], name, baseUrl, apiKey, model };
    }
  } else {
    // Add new
    models.push({
      id: "custom-" + Date.now(),
      name,
      baseUrl,
      apiKey,
      model,
      builtin: false,
    });
  }

  await chrome.storage.sync.set({ aiModels: models });

  setTimeout(() => {
    saveModelBtn.disabled = false;
    saveModelBtn.textContent = "保存";
    showEditStatus("success", "保存成功");
    setTimeout(() => {
      closeEditModal();
      renderModelList();
    }, 500);
  }, 300);
});

function showEditStatus(type, message) {
  editStatus.textContent = message;
  editStatus.className = `config-status ${type}`;
  setTimeout(() => {
    editStatus.textContent = "";
    editStatus.className = "config-status";
  }, 3000);
}

// --- Action Logic ---

// 确保 content script 已注入到目标页面
async function ensureContentScriptInjected(tabId) {
  try {
    // 先尝试发送一个测试消息
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: "getStatus" }, (response) => {
        if (chrome.runtime.lastError) {
          // Content script 未加载，尝试注入
          console.log("[popup] Content script 未加载，尝试注入...");
          injectContentScript(tabId)
            .then(resolve)
            .catch(() => resolve(false));
        } else {
          // 已加载
          resolve(true);
        }
      });
    });
  } catch (e) {
    console.error("[popup] 检查 content script 失败:", e);
    return false;
  }
}

// 程序化注入 content script
async function injectContentScript(tabId) {
  try {
    // 检查是否是可以注入的页面
    const tab = await chrome.tabs.get(tabId);
    if (
      !tab.url ||
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("chrome-extension://") ||
      tab.url.startsWith("edge://") ||
      tab.url.startsWith("about:")
    ) {
      console.log("[popup] 无法在系统页面注入脚本");
      return false;
    }

    // 注入 CSS
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"],
    });

    // 按顺序注入 JS 模块
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        "modules/site-matcher.js",
        "modules/template-manager.js",
        "modules/scanner-enhanced.js",
        "content.js",
      ],
    });

    console.log("[popup] Content script 注入成功");
    // 等待脚本初始化
    await new Promise((resolve) => setTimeout(resolve, 200));
    return true;
  } catch (e) {
    console.error("[popup] 注入 content script 失败:", e);
    return false;
  }
}

// 1. Scan
scanBtn.addEventListener("click", async () => {
  const activeModel = await getActiveModel();
  const config = {
    baseUrl: activeModel.baseUrl,
    apiKey: activeModel.apiKey,
    model: activeModel.model,
  };

  addLog("info", "正在扫描题目...");
  updateStatus("running", "扫描中...");
  scanBtn.disabled = true;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) {
    addLog("error", "无法获取当前标签页");
    updateStatus("error", "连接失败");
    scanBtn.disabled = false;
    return;
  }

  const tab = tabs[0];

  // 检查是否是系统页面
  if (
    !tab.url ||
    tab.url.startsWith("chrome://") ||
    tab.url.startsWith("chrome-extension://") ||
    tab.url.startsWith("edge://") ||
    tab.url.startsWith("about:")
  ) {
    addLog("error", "请切换到有题目的网页再扫描");
    updateStatus("error", "系统页面");
    scanBtn.disabled = false;
    return;
  }

  // 确保 content script 已注入
  const injected = await ensureContentScriptInjected(tab.id);
  if (!injected) {
    addLog("error", "无法连接到页面，请刷新页面后重试");
    updateStatus("error", "连接失败");
    scanBtn.disabled = false;
    return;
  }

  chrome.tabs.sendMessage(tab.id, { action: "scan", config }, (response) => {
    scanBtn.disabled = false;

    if (chrome.runtime.lastError) {
      addLog("error", "连接失败，请刷新页面后重试");
      updateStatus("error", "连接失败");
      return;
    }

    if (response && response.success) {
      questionCount.textContent = response.count;
      hasScanned = true;
      startBtn.disabled = false;
      addLog("success", `扫描完成: ${response.count} 题`);
      updateStatus("ready", "扫描完成");
    } else {
      addLog("warning", response?.message || "未发现题目");
      updateStatus("ready", "未发现题目");
    }
  });
});

// 2. Start/Pause Toggle
startBtn.addEventListener("click", async () => {
  if (!hasScanned && !isRunning) return;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) {
    addLog("error", "无法获取当前标签页");
    return;
  }

  const tab = tabs[0];

  if (isRunning) {
    // Pause/Stop
    setRunningState(false);
    addLog("warning", "已暂停答题");
    chrome.tabs.sendMessage(tab.id, { action: "stop" });
  } else {
    // 检查是否是系统页面
    if (
      !tab.url ||
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("chrome-extension://") ||
      tab.url.startsWith("edge://") ||
      tab.url.startsWith("about:")
    ) {
      addLog("error", "请切换到有题目的网页");
      return;
    }

    // 确保 content script 已注入
    const injected = await ensureContentScriptInjected(tab.id);
    if (!injected) {
      addLog("error", "无法连接到页面，请刷新页面后重试");
      return;
    }

    // Start
    const activeModel = await getActiveModel();
    const config = {
      baseUrl: activeModel.baseUrl,
      apiKey: activeModel.apiKey,
      model: activeModel.model,
    };

    setRunningState(true);
    addLog("info", "🚀 开始自动答题");
    chrome.tabs.sendMessage(
      tab.id,
      {
        action: "start",
        config: config,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          setRunningState(false);
          addLog("error", "连接中断，请刷新页面后重试");
        }
      }
    );
  }
});

function setRunningState(active) {
  isRunning = active;
  if (active) {
    startBtn.disabled = false;
    startBtnText.textContent = "暂停答题";
    startBtn.classList.remove("btn-dark");
    startBtn.classList.add("btn-warning");
    scanBtn.disabled = true;
    updateStatus("running", "答题中...");
  } else {
    startBtn.disabled = !hasScanned; // Keep enabled if we have scanned
    startBtnText.textContent = "开始自动答题";
    startBtn.classList.remove("btn-warning");
    startBtn.classList.add("btn-dark");
    scanBtn.disabled = false;
    updateStatus("ready", "就绪");
  }
}

// --- Helpers ---

function updateStatus(type, text) {
  statusDot.className = `status-dot ${type}`;
  statusText.textContent = text;
}

function addLog(type, message) {
  const time = new Date().toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const logItem = document.createElement("div");
  logItem.className = `log-item log-${type}`;
  logItem.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-msg">${message}</span>
  `;
  logContent.appendChild(logItem);
  logContent.scrollTop = logContent.scrollHeight;
}

clearLogBtn.addEventListener("click", () => {
  logContent.innerHTML = "";
  addLog("info", "日志已清空");
});

// Message Listener
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "log":
      addLog(message.level, message.text);
      break;
    case "updateStats":
      questionCount.textContent = message.questionCount;
      answeredCount.textContent = message.answeredCount;
      break;
    case "complete":
      setRunningState(false);
      updateStatus("ready", "完成");
      addLog("success", `🎉 全部完成 (共${message.answeredCount}题)`);
      break;
    case "error":
      setRunningState(false);
      updateStatus("error", "错误");
      addLog("error", message.text);
      break;
  }
});
