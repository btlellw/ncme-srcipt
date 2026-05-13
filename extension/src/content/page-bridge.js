(() => {
  "use strict";

  if (window.__NCME_PAGE_BRIDGE__) return;
  window.__NCME_PAGE_BRIDGE__ = true;

  const FROM_PAGE = "NCME_EXT_FROM_PAGE";
  const TO_PAGE = "NCME_EXT_TO_PAGE";
  const FROM_PANEL = "NCME_EXT_FROM_PANEL";
  const STORAGE = {
    aiConfig: "ncme.auto.aiConfig",
    autoStopped: "ncme.auto.stopped",
    courseSnapshot: "ncme.auto.courseSnapshot",
    examAnswerBank: "ncme.auto.examAnswerBank",
    examAnswerDraft: "ncme.auto.examAnswerDraft",
    examPayloads: "ncme.auto.examPayloads",
  };

  let nextRequestId = 1;
  const pendingProxy = new Map();

  window.unsafeWindow = window;
  window.GM_xmlhttpRequest = function GM_xmlhttpRequest(details) {
    const requestId = `gm-${Date.now()}-${nextRequestId++}`;
    const timeoutMs = Number(details.timeout || 30000);
    const timer = setTimeout(() => {
      const item = pendingProxy.get(requestId);
      if (!item) return;
      pendingProxy.delete(requestId);
      item.details.ontimeout?.({ status: 0, responseText: "", error: "timeout" });
    }, timeoutMs + 1000);

    pendingProxy.set(requestId, { details, timer });
    window.postMessage(
      {
        source: FROM_PAGE,
        type: "GM_XMLHTTP_REQUEST",
        requestId,
        payload: {
          method: details.method || "GET",
          url: details.url,
          headers: details.headers || {},
          data: details.data,
          timeout: timeoutMs,
        },
      },
      "*",
    );

    return {
      abort() {
        const item = pendingProxy.get(requestId);
        if (!item) return;
        pendingProxy.delete(requestId);
        clearTimeout(item.timer);
      },
    };
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data || {};

    if (message.source === TO_PAGE && message.type === "GM_XMLHTTP_RESPONSE") {
      const item = pendingProxy.get(message.requestId);
      if (!item) return;
      pendingProxy.delete(message.requestId);
      clearTimeout(item.timer);

      const details = item.details;
      const response = message.response || {};
      if (response.ok) {
        details.onload?.(response.payload);
      } else {
        details.onerror?.({ status: 0, responseText: "", error: response.error || "proxy failed" });
      }
      return;
    }

    if (message.source === FROM_PANEL && message.type === "COMMAND") {
      Promise.resolve()
        .then(() => handleCommand(message.command, message.payload || {}))
        .then((payload) => {
          window.postMessage(
            { source: FROM_PAGE, type: "COMMAND_RESPONSE", requestId: message.requestId, ok: true, payload },
            "*",
          );
        })
        .catch((error) => {
          window.postMessage(
            {
              source: FROM_PAGE,
              type: "COMMAND_RESPONSE",
              requestId: message.requestId,
              ok: false,
              error: error.message || String(error),
            },
            "*",
          );
        });
    }
  });

  function handleCommand(command, payload) {
    const debug = window.__NCME_AUTO_DEBUG__;
    switch (command) {
      case "getStatus":
        return getStatus(debug);
      case "setAiConfig":
        return setAiConfig(debug, payload.config || payload);
      case "resumeAutomation":
        return debug?.resumeListAutomation?.() ?? removeJson(STORAGE.autoStopped);
      case "pauseAutomation":
        return pauseAutomation(payload.reason || "paused-from-extension");
      case "runDebugMethod":
        return runDebugMethod(debug, payload.method, payload.args || []);
      case "setAnswerBank":
        return setJson(STORAGE.examAnswerBank, payload.bank || {});
      case "clearAnswerBank":
        return debug?.clearExamAnswerBank?.() ?? removeJson(STORAGE.examAnswerBank);
      case "clearAnswerDraft":
        return debug?.clearExamAnswerDraft?.() ?? removeJson(STORAGE.examAnswerDraft);
      case "setExamPayloadConfigs":
        return debug?.setExamPayloadConfigs?.(payload.configs || {}) ?? setJson(STORAGE.examPayloads, payload.configs || {});
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  function getStatus(debug) {
    const status = {
      url: location.href,
      title: document.title,
      ready: !!debug,
      stopped: readJson(STORAGE.autoStopped, null),
      aiConfig: readJson(STORAGE.aiConfig, null),
      courseSnapshot: readJson(STORAGE.courseSnapshot, null),
      examAnswerBank: readJson(STORAGE.examAnswerBank, null),
      examAnswerDraft: readJson(STORAGE.examAnswerDraft, null),
      debugVersion: debug?.version || "",
    };

    if (debug) {
      status.debug = {
        automationStopped: safeCall(() => debug.getAutomationStopped?.()),
        activePlayer: safeCall(() => debug.getActivePlayer?.()),
        examState: safeCall(() => debug.getExamState?.()),
        examAnswerSheet: safeCall(() => debug.getExamAnswerSheet?.()),
      };
    }

    return status;
  }

  function setAiConfig(debug, config) {
    const next = {
      enabled: !!config.enabled,
      endpoint: String(config.endpoint || "").trim(),
      apiKey: String(config.apiKey || "").trim(),
      model: String(config.model || "").trim(),
      timeoutMs: Number(config.timeoutMs || 30000),
      temperature: Number(config.temperature ?? 0),
      maxTokens: Number(config.maxTokens || 32),
      maxQuestionsPerRequest: Number(config.maxQuestionsPerRequest || 10),
    };

    if (!next.endpoint) throw new Error("AI endpoint is required");
    if (!next.model) throw new Error("AI model is required");

    if (debug?.setAiConfig) {
      debug.setAiConfig(next);
    } else {
      setJson(STORAGE.aiConfig, next);
    }
    return readJson(STORAGE.aiConfig, next);
  }

  function pauseAutomation(reason) {
    const payload = {
      reason,
      detail: { source: "extension" },
      url: location.href,
      updatedAt: Date.now(),
    };
    setJson(STORAGE.autoStopped, payload);
    return payload;
  }

  function runDebugMethod(debug, method, args) {
    if (!debug) throw new Error("NCME automation runtime is not ready");
    if (!method || typeof debug[method] !== "function") {
      throw new Error(`Debug method not found: ${method}`);
    }
    return debug[method](...args);
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function setJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
    return value;
  }

  function removeJson(key) {
    localStorage.removeItem(key);
    return true;
  }

  function safeCall(fn) {
    try {
      return fn();
    } catch (error) {
      return { error: error.message || String(error) };
    }
  }
})();
