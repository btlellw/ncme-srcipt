(() => {
  "use strict";

  if (window.__NCME_EXTENSION_BRIDGE__) return;
  window.__NCME_EXTENSION_BRIDGE__ = true;

  const FROM_PAGE = "NCME_EXT_FROM_PAGE";
  const TO_PAGE = "NCME_EXT_TO_PAGE";
  const FROM_PANEL = "NCME_EXT_FROM_PANEL";
  let nextRequestId = 1;
  const pending = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data || {};

    if (message.source === FROM_PAGE && message.type === "GM_XMLHTTP_REQUEST") {
      chrome.runtime.sendMessage(
        { type: "NCME_PROXY_REQUEST", payload: message.payload },
        (response) => {
          window.postMessage(
            {
              source: TO_PAGE,
              type: "GM_XMLHTTP_RESPONSE",
              requestId: message.requestId,
              response: response || {
                ok: false,
                error: chrome.runtime.lastError?.message || "Proxy request failed",
              },
            },
            "*",
          );
        },
      );
      return;
    }

    if (message.source === FROM_PAGE && message.type === "COMMAND_RESPONSE") {
      const item = pending.get(message.requestId);
      if (!item) return;
      pending.delete(message.requestId);
      clearTimeout(item.timer);
      if (message.ok) {
        item.resolve(message.payload);
      } else {
        item.reject(new Error(message.error || "Page command failed"));
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "NCME_PAGE_COMMAND") return false;

    sendPageCommand(message.command, message.payload, message.timeoutMs)
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

    return true;
  });

  function sendPageCommand(command, payload = {}, timeoutMs = 5000) {
    const requestId = `cmd-${Date.now()}-${nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Page command timeout; reload the NCME tab if the extension was just installed"));
      }, Number(timeoutMs) || 5000);

      pending.set(requestId, { resolve, reject, timer });
      window.postMessage(
        {
          source: FROM_PANEL,
          type: "COMMAND",
          requestId,
          command,
          payload,
        },
        "*",
      );
    });
  }
})();
