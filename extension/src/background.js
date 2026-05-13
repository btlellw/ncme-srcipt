const DEFAULT_TIMEOUT_MS = 30000;

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id && chrome.sidePanel?.open) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "NCME_PROXY_REQUEST") return false;

  proxyRequest(message.payload || {})
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

async function proxyRequest(request) {
  const url = String(request.url || "");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Only http(s) proxy requests are supported");
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Request timeout")),
    Number(request.timeout || DEFAULT_TIMEOUT_MS),
  );

  try {
    const response = await fetch(url, {
      method: request.method || "GET",
      headers: sanitizeHeaders(request.headers || {}),
      body: request.data ?? request.body,
      credentials: "omit",
      signal: controller.signal,
    });

    const responseText = await response.text();
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      status: response.status,
      statusText: response.statusText,
      responseText,
      responseHeaders,
      finalUrl: response.url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (!key) continue;
    out[key] = String(value);
  }
  return out;
}
