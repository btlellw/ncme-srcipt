const DEFAULT_AI = {
  enabled: false,
  endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  apiKey: "",
  model: "glm-4-flash",
  timeoutMs: 30000,
  temperature: 0,
  maxTokens: 32,
  maxQuestionsPerRequest: 10,
};

const els = {
  runtimeBadge: document.getElementById("runtimeBadge"),
  refreshBtn: document.getElementById("refreshBtn"),
  resumeBtn: document.getElementById("resumeBtn"),
  pauseBtn: document.getElementById("pauseBtn"),
  pageUrl: document.getElementById("pageUrl"),
  runtimeStatus: document.getElementById("runtimeStatus"),
  stopReason: document.getElementById("stopReason"),
  paperStatus: document.getElementById("paperStatus"),
  aiEnabled: document.getElementById("aiEnabled"),
  aiEndpoint: document.getElementById("aiEndpoint"),
  aiApiKey: document.getElementById("aiApiKey"),
  aiModel: document.getElementById("aiModel"),
  aiTimeout: document.getElementById("aiTimeout"),
  aiMaxQuestions: document.getElementById("aiMaxQuestions"),
  saveAiBtn: document.getElementById("saveAiBtn"),
  toggleKeyBtn: document.getElementById("toggleKeyBtn"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  log: document.getElementById("log"),
};

document.addEventListener("DOMContentLoaded", refreshStatus);
els.refreshBtn.addEventListener("click", refreshStatus);
els.saveAiBtn.addEventListener("click", saveAiConfig);
els.resumeBtn.addEventListener("click", () => runCommand("resumeAutomation").then(refreshStatus));
els.pauseBtn.addEventListener("click", () => runCommand("pauseAutomation", { reason: "paused-from-extension" }).then(refreshStatus));
els.toggleKeyBtn.addEventListener("click", () => {
  els.aiApiKey.type = els.aiApiKey.type === "password" ? "text" : "password";
});
els.clearLogBtn.addEventListener("click", () => {
  els.log.textContent = "";
});

addMaintenanceButtons();

document.querySelectorAll("[data-debug]").forEach((button) => {
  button.addEventListener("click", async () => {
    const method = button.dataset.debug;
    try {
      const result = await runCommand("runDebugMethod", { method });
      addLog(`OK ${method}: ${formatResult(result)}`);
      await refreshStatus();
    } catch (error) {
      addLog(`ERR ${method}: ${error.message}`);
    }
  });
});

function addMaintenanceButtons() {
  const actionRow = document.querySelector("[data-debug='autoSubmitExam']")?.parentElement;
  if (!actionRow || document.getElementById("clearAnswerBankBtn")) return;

  const clearBankBtn = document.createElement("button");
  clearBankBtn.id = "clearAnswerBankBtn";
  clearBankBtn.className = "danger";
  clearBankBtn.textContent = "\u6e05\u7a7a\u9898\u5e93";
  clearBankBtn.addEventListener("click", async () => {
    if (!confirm("\u786e\u5b9a\u6e05\u7a7a\u5f53\u524d NCME \u9875\u9762\u7684\u672c\u5730\u9898\u5e93\uff1f")) return;
    try {
      await runCommand("clearAnswerBank");
      addLog("\u9898\u5e93\u5df2\u6e05\u7a7a");
      await refreshStatus();
    } catch (error) {
      addLog(`\u6e05\u7a7a\u9898\u5e93\u5931\u8d25: ${error.message}`);
    }
  });

  const clearDraftBtn = document.createElement("button");
  clearDraftBtn.id = "clearAnswerDraftBtn";
  clearDraftBtn.textContent = "\u6e05\u7a7a\u7b54\u9898\u8349\u7a3f";
  clearDraftBtn.addEventListener("click", async () => {
    try {
      await runCommand("clearAnswerDraft");
      addLog("\u7b54\u9898\u8349\u7a3f\u5df2\u6e05\u7a7a");
      await refreshStatus();
    } catch (error) {
      addLog(`\u6e05\u7a7a\u7b54\u9898\u8349\u7a3f\u5931\u8d25: ${error.message}`);
    }
  });

  actionRow.appendChild(clearBankBtn);
  actionRow.appendChild(clearDraftBtn);
}

async function refreshStatus() {
  try {
    const status = await runCommand("getStatus", {}, 8000);
    renderStatus(status);
    addLog(`状态刷新: ${status.ready ? "runtime ready" : "runtime loading"}`);
  } catch (error) {
    setBadge("未连接", "err");
    els.runtimeStatus.textContent = "无法连接到 NCME 页面";
    addLog(`状态刷新失败: ${error.message}`);
  }
}

async function saveAiConfig() {
  const config = {
    enabled: els.aiEnabled.checked,
    endpoint: els.aiEndpoint.value.trim(),
    apiKey: els.aiApiKey.value.trim(),
    model: els.aiModel.value.trim(),
    timeoutMs: Number(els.aiTimeout.value || DEFAULT_AI.timeoutMs),
    temperature: 0,
    maxTokens: DEFAULT_AI.maxTokens,
    maxQuestionsPerRequest: Number(els.aiMaxQuestions.value || DEFAULT_AI.maxQuestionsPerRequest),
  };

  try {
    await runCommand("setAiConfig", { config });
    addLog("AI 配置已保存到当前 NCME 页面的 localStorage");
    await refreshStatus();
  } catch (error) {
    addLog(`AI 配置保存失败: ${error.message}`);
  }
}

function renderStatus(status) {
  setBadge(status.ready ? "已连接" : "加载中", status.ready ? "ok" : "");
  els.pageUrl.textContent = status.url || "-";
  els.runtimeStatus.textContent = status.ready
    ? `运行中 (${status.debugVersion || "unknown"})`
    : "桥已加载，自动化脚本尚未就绪";
  els.stopReason.textContent = status.stopped?.reason || status.debug?.automationStopped?.reason || "-";

  const sheet = status.debug?.examAnswerSheet || {};
  els.paperStatus.textContent = sheet.paperNo
    ? `paper ${sheet.paperNo}: ${sheet.sequence || ""}`
    : "未识别/非考试页";

  const ai = { ...DEFAULT_AI, ...(status.aiConfig || {}) };
  els.aiEnabled.checked = !!ai.enabled;
  els.aiEndpoint.value = ai.endpoint || "";
  els.aiApiKey.value = ai.apiKey || "";
  els.aiModel.value = ai.model || "";
  els.aiTimeout.value = ai.timeoutMs || DEFAULT_AI.timeoutMs;
  els.aiMaxQuestions.value = ai.maxQuestionsPerRequest || DEFAULT_AI.maxQuestionsPerRequest;
}

async function runCommand(command, payload = {}, timeoutMs = 5000) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("找不到当前标签页");
  if (!/^https:\/\/www\.ncme\.org\.cn\//i.test(tab.url || "")) {
    throw new Error("请切换到 https://www.ncme.org.cn/ 页面后再操作");
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tab.id,
      { type: "NCME_PAGE_COMMAND", command, payload, timeoutMs },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "命令执行失败"));
          return;
        }
        resolve(response.payload);
      },
    );
  });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function setBadge(text, type) {
  els.runtimeBadge.textContent = text;
  els.runtimeBadge.className = `badge ${type || ""}`;
}

function addLog(message) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  els.log.textContent += `[${time}] ${message}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function formatResult(value) {
  if (value === undefined) return "triggered; no return value";
  if (value === false) return "false; action did not run or page state is not ready";
  if (value === true) return "true";
  if (typeof value === "string") return value.slice(0, 300);
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch (_) {
    return String(value).slice(0, 300);
  }
}
