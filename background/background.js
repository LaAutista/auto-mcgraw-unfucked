let mheTabId = null;
let aiTabId = null;
let aiType = null;
let processingQuestion = false;
let queuedRestart = null;
let allowQueuedRestart = false;
let mheWindowId = null;
let aiWindowId = null;
let duplicateTabId = null;
let originalTabId = null;
let storedResponse = null;
let isProcessingDuplicate = false;
let pendingResponse = null;
const promiseApi = globalThis.browser ?? chrome;
const REQUEST_KEY_PREFIX = "autoMcGrawRequest:";
const DEEPSEEK_URL_PATTERNS = [
  "https://chat.deepseek.com/*",
];
const DIAGNOSTICS_KEY = "autoMcGrawDiagnostics";
const DIAGNOSTICS_LIMIT = 300;
const DIAGNOSTIC_NUMBER_FIELDS = new Set([
  "tabId", "windowId", "sourceTabId", "sourceWindowId", "targetTabId", "frameId",
  "attempt", "optionCount", "answerCount", "selectedCount", "elapsedMs",
  "messageCount", "candidateLength", "completedCount", "totalCount",
  "matchedCount", "unmatchedCount", "blankCount", "filledCount", "movedCount", "retryCount", "imageCount",
]);
const DIAGNOSTIC_BOOLEAN_FIELDS = new Set([
  "received", "stale", "retryable", "automating", "pauseBeforeSubmit", "generating",
  "stable", "hasContainer", "hasAnswer", "hasRequest", "enabled", "queued",
]);
const DIAGNOSTIC_CATEGORIES = {
  questionType: new Set([
    "multiple_choice", "multiple_response", "multiple_select", "true_false",
    "fill_in_the_blank", "matching", "ranking", "worksheet_mc", "sim_choice", "select_text",
  ]),
  status: new Set([
    "queued", "busy", "sending", "processing", "already-processing", "waiting",
    "submitted", "accepted", "applied", "delivered", "stale", "retrying", "failed",
    "stopped", "completed", "canceled", "ready", "unknown",
  ]),
  errorName: new Set([
    "Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "DOMException",
    "AbortError", "TimeoutError", "NotAllowedError", "SecurityError", "QuotaExceededError",
    "UnknownError",
  ]),
};
const DIAGNOSTIC_HOSTS = new Set([
  "learning.mheducation.com", "ezto.mheducation.com", "connect.mheducation.com",
  "newconnect.mheducation.com", "chatgpt.com", "gemini.google.com",
  "chat.deepseek.com", "deepseek.chat", "sfc.muzzylane.com",
]);
let diagnosticsWrites = Promise.resolve();

function diagnosticDetails(details = {}) {
  return Object.fromEntries(Object.entries(details || {}).filter(([key, value]) =>
    (DIAGNOSTIC_NUMBER_FIELDS.has(key) && Number.isSafeInteger(value)) ||
    (DIAGNOSTIC_BOOLEAN_FIELDS.has(key) && typeof value === "boolean") ||
    (Object.hasOwn(DIAGNOSTIC_CATEGORIES, key) && DIAGNOSTIC_CATEGORIES[key].has(value))
  ));
}

function recordDiagnostic(stage, requestId, details = {}, source = "background") {
  if (!promiseApi.storage.local || typeof stage !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(stage)) {
    return Promise.resolve(false);
  }
  const event = {
    timestamp: new Date().toISOString(),
    extensionVersion: promiseApi.runtime.getManifest?.().version || "unknown",
    source,
    stage,
    requestId: typeof requestId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(requestId) ? requestId : null,
    details: diagnosticDetails(details),
  };
  diagnosticsWrites = diagnosticsWrites.then(async () => {
    const stored = await promiseApi.storage.local.get(DIAGNOSTICS_KEY);
    const events = Array.isArray(stored[DIAGNOSTICS_KEY]) ? stored[DIAGNOSTICS_KEY] : [];
    await promiseApi.storage.local.set({
      [DIAGNOSTICS_KEY]: [...events.slice(-(DIAGNOSTICS_LIMIT - 1)), event],
    });
    return true;
  }).catch(() => false); // Diagnostics must never interrupt answer delivery.
  return diagnosticsWrites;
}

async function getDiagnostics() {
  await diagnosticsWrites;
  if (!promiseApi.storage.local) return [];
  const stored = await promiseApi.storage.local.get(DIAGNOSTICS_KEY);
  return Array.isArray(stored[DIAGNOSTICS_KEY]) ? stored[DIAGNOSTICS_KEY].slice(-DIAGNOSTICS_LIMIT) : [];
}

function diagnosticSource(sender) {
  try {
    const url = new URL(sender.url || sender.tab?.url);
    return url.protocol === "https:" && DIAGNOSTIC_HOSTS.has(url.hostname) ? url.hostname : null;
  } catch {
    return null;
  }
}

function isDeepSeekTabUrl(url = "") {
  return url.includes("chat.deepseek.com") || url.includes("deepseek.chat");
}

function storeAiTab(tabs, preferredWindowId) {
  const tab =
    tabs.find((candidate) => candidate.windowId === preferredWindowId) || tabs[0];
  aiTabId = tab?.id ?? null;
  aiWindowId = tab?.windowId ?? null;
}

function sendMessageWithRetry(tabId, message, maxAttempts = 3, delay = 1000) {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    function attemptSend() {
      attempts++;
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          recordDiagnostic(attempts < maxAttempts ? "transport.retry" : "transport.error", message.requestId, {
            targetTabId: tabId, attempt: attempts,
          });
          if (attempts < maxAttempts) {
            setTimeout(attemptSend, delay);
          } else {
            reject(chrome.runtime.lastError);
          }
        } else {
          resolve(response);
        }
      });
    }

    attemptSend();
  });
}

function requestKey(requestId) {
  return `${REQUEST_KEY_PREFIX}${requestId}`;
}

async function rememberRequest(requestId, tabId, windowId) {
  await promiseApi.storage.session.set({
    [requestKey(requestId)]: { tabId, windowId },
  });
}

async function getRequest(requestId) {
  if (!requestId) return null;
  const key = requestKey(requestId);
  return (await promiseApi.storage.session.get(key))[key] || null;
}

async function forgetRequest(requestId) {
  if (requestId) await promiseApi.storage.session.remove(requestKey(requestId));
}

async function focusTab(tabId) {
  if (!tabId) return false;

  try {
    const tab = await promiseApi.tabs.get(tabId);
    await promiseApi.tabs.update(tabId, { active: true });
    recordDiagnostic("tab.activated", null, { tabId, windowId: tab.windowId });
    await promiseApi.windows.update(tab.windowId, { focused: true }).catch((error) => {
      recordDiagnostic("tab.focus_failed", null, { tabId, windowId: tab.windowId, errorName: error.name });
      console.warn("[Auto-McGraw] Tab activated, but could not focus its window:", error);
    });
    return true;
  } catch (error) {
    recordDiagnostic("tab.activation_failed", null, { tabId, errorName: error.name });
    console.warn("[Auto-McGraw] Could not activate tab:", error);
    return false;
  }
}

async function findAndStoreTabs(preferredWindowId) {
  const mheTabs = await promiseApi.tabs.query({
    url: [
      "https://learning.mheducation.com/*",
      "https://ezto.mheducation.com/*",
      "https://connect.mheducation.com/*",
      "https://newconnect.mheducation.com/*",
    ],
  });
  if (mheTabs.length > 0) {
    mheTabId = mheTabs[0].id;
    mheWindowId = mheTabs[0].windowId;
  }

  const data = await promiseApi.storage.sync.get("aiModel");
  const aiModel = data.aiModel || "chatgpt";
  aiType = aiModel;

  if (aiModel === "chatgpt") {
    const tabs = await promiseApi.tabs.query({ url: "https://chatgpt.com/*" });
    storeAiTab(tabs, preferredWindowId);
  } else if (aiModel === "gemini") {
    const tabs = await promiseApi.tabs.query({
      url: "https://gemini.google.com/*",
    });
    storeAiTab(tabs, preferredWindowId);
  } else if (aiModel === "deepseek") {
    const tabs = await promiseApi.tabs.query({
      url: DEEPSEEK_URL_PATTERNS,
    });
    storeAiTab(tabs, preferredWindowId);
  }
}

async function shouldFocusTabs() {
  const { tabSwitchingEnabled } = await promiseApi.storage.sync.get(
    "tabSwitchingEnabled"
  );
  return tabSwitchingEnabled !== false;
}

async function resolveQuestionImages(question, provider, requestId) {
  const inputs = question?.images;
  if (inputs === undefined || (Array.isArray(inputs) && inputs.length === 0)) return question;
  const imageCount = Array.isArray(inputs) ? inputs.length : 0;
  try {
    if (!Array.isArray(inputs) || inputs.length > 4) throw new Error("A question can include at most four images.");
    if (provider !== "chatgpt") throw new Error("Questions with images currently require ChatGPT.");
    if ((await promiseApi.permissions?.contains({
      origins: ["https://smartfactory-api.prod.mheducation.com/*"],
    })) === false) throw new Error("Enable question image access in extension settings.");
    const images = [];
    for (const image of inputs) {
      const url = new URL(image?.src);
      if (
        url.origin !== "https://smartfactory-api.prod.mheducation.com" ||
        !url.pathname.startsWith("/files/smart-factory/") ||
        url.username || url.password || url.search || url.hash
      ) throw new Error("Question image URL is outside the supported McGraw image location.");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url.href, {
          credentials: "include", redirect: "error", signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Question image download failed (HTTP ${response.status}).`);
        const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) {
          throw new Error("Question image has an unsupported image format.");
        }
        const limit = 2 * 1024 * 1024;
        if (Number(response.headers.get("content-length")) > limit) {
          throw new Error("Question image exceeds the 2 MiB limit.");
        }
        const reader = response.body.getReader();
        let size = 0;
        let binary = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) throw new Error("Question image exceeds the 2 MiB limit.");
            for (let offset = 0; offset < value.length; offset += 32768) {
              binary += String.fromCharCode(...value.subarray(offset, offset + 32768));
            }
          }
        } finally {
          reader.releaseLock();
        }
        if (!size) throw new Error("Question image was empty.");
        images.push({
          src: url.href, alt: typeof image.alt === "string" ? image.alt.slice(0, 1000) : "",
          dataUrl: `data:${mime};base64,${btoa(binary)}`,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new Error("Question image download timed out.");
        throw error;
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    }
    recordDiagnostic("image.ready", requestId, { imageCount });
    return { ...question, images };
  } catch (error) {
    recordDiagnostic("image.error", requestId, { imageCount });
    throw error;
  }
}

async function processQuestion(message) {
  recordDiagnostic("question.enqueue", message.requestId, {
    sourceTabId: message.sourceTabId, sourceWindowId: message.sourceWindowId,
    questionType: message.question?.type,
  });
  if (processingQuestion) {
    recordDiagnostic(allowQueuedRestart ? "question.queued" : "question.busy", message.requestId, {
      queued: allowQueuedRestart,
    });
    if (allowQueuedRestart) queuedRestart = message;
    return allowQueuedRestart
      ? { received: true, status: "queued" }
      : { received: false, retryable: true, status: "busy" };
  }
  processingQuestion = true;
  allowQueuedRestart = false;
  const requestId = message.requestId || crypto.randomUUID();

  try {
    await findAndStoreTabs(message.sourceWindowId);
    mheTabId = message.sourceTabId;
    mheWindowId = message.sourceWindowId;

    if (!aiTabId) {
      recordDiagnostic("question.provider_missing", requestId);
      if (!allowQueuedRestart && !queuedRestart) {
        await sendMessageWithRetry(mheTabId, {
          type: "alertMessage",
          message: `Please open ${aiType} in another tab before using automation.`,
        });
      }
      if (!allowQueuedRestart && !queuedRestart) {
        await sendMessageWithRetry(mheTabId, { type: "stopAutomation" });
      }
      return;
    }

    const question = await resolveQuestionImages(message.question, aiType, requestId);
    const switchTabs = await shouldFocusTabs();

    if (switchTabs) {
      await focusTab(aiTabId);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    await rememberRequest(requestId, mheTabId, mheWindowId);

    recordDiagnostic("question.send", requestId, { sourceTabId: mheTabId, targetTabId: aiTabId });
    const aiResponse = await sendMessageWithRetry(aiTabId, {
      type: "receiveQuestion",
      requestId,
      question,
    });
    recordDiagnostic("question.provider_ack", requestId, {
      received: !!aiResponse?.received, stale: !!aiResponse?.stale, status: aiResponse?.status,
    });

    if (aiResponse && aiResponse.received === false) {
      await forgetRequest(requestId);
      if (!aiResponse.stale && !allowQueuedRestart && !queuedRestart) {
        await sendMessageWithRetry(mheTabId, {
          type: "alertMessage",
          message: `Could not enter the question into ${aiType}: ${
            aiResponse.error || "unknown error"
          }. Check the ${aiType} tab.`,
        });
        await sendMessageWithRetry(mheTabId, { type: "stopAutomation" });
      }
    }

    // Keep the provider visible while its answer renders; processResponse returns
    // to McGraw only after the answer is ready, avoiding paused background animations.
  } catch (error) {
    recordDiagnostic("question.error", requestId, { errorName: error.name });
    await forgetRequest(requestId);
    if (mheTabId && !allowQueuedRestart && !queuedRestart) {
      await sendMessageWithRetry(mheTabId, {
        type: "alertMessage",
        message: `Error communicating with ${aiType}: ${error.message || "unknown error"}. Please check the assistant tab.`,
      });
      if (!allowQueuedRestart && !queuedRestart) {
        await sendMessageWithRetry(mheTabId, { type: "stopAutomation" });
      }
    }
    return { received: false, error: error.message };
  } finally {
    processingQuestion = false;
    if (queuedRestart) {
      const nextQuestion = queuedRestart;
      queuedRestart = null;
      await processQuestion(nextQuestion);
    }
  }
}

async function processResponse(message) {
  recordDiagnostic("response.received", message.requestId, {
    candidateLength: typeof message.response === "string" ? message.response.length : 0,
  });
  const request = await getRequest(message.requestId);
  if (!request) {
    recordDiagnostic("response.stale", message.requestId, { hasRequest: false });
    return { received: false, stale: true };
  }

  const targetTabId = request.tabId;
  mheTabId = request.tabId;
  mheWindowId = request.windowId;
  recordDiagnostic("response.route", message.requestId, { targetTabId, windowId: request.windowId });

  try {
    pendingResponse = message.response;

    const switchTabs = await shouldFocusTabs();

    if (switchTabs) {
      await focusTab(targetTabId);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const currentRequest = await getRequest(message.requestId);
    if (
      !currentRequest ||
      currentRequest.tabId !== targetTabId ||
      currentRequest.windowId !== request.windowId
    ) {
      recordDiagnostic("response.stale", message.requestId, { hasRequest: !!currentRequest });
      return { received: false, stale: true };
    }

    const delivery = await sendMessageWithRetry(targetTabId, {
      type: "processChatGPTResponse",
      requestId: message.requestId,
      response: message.response,
    });
    recordDiagnostic("response.delivery", message.requestId, {
      targetTabId, received: !!delivery?.received, stale: !!delivery?.stale,
    });

    if (!delivery?.received) {
      if (delivery?.stale) {
        await forgetRequest(message.requestId);
      }
      return delivery || { received: false };
    }

    await forgetRequest(message.requestId);
    return { received: true };
  } catch (error) {
    recordDiagnostic("response.error", message.requestId, { errorName: error.name });
    console.error("Error processing AI response:", error);
    return { received: false, error: error.message };
  }
}

async function waitForTabReady(tabId, maxAttempts = 8) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await promiseApi.tabs.get(tabId);

      await sendMessageWithRetry(tabId, { type: "ping" }, 1, 300);

      const tab = await promiseApi.tabs.get(tabId);
      if (tab.status === "complete") {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return true;
      }
    } catch (error) {
      console.log(`Tab ${tabId} not ready, attempt ${i + 1}:`, error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Telemetry must not change the provider/source tab selected by an active request.
  if (message.type === "diagnosticEvent") {
    const source = diagnosticSource(sender);
    if (!source) {
      sendResponse({ received: false });
      return false;
    }
    recordDiagnostic(message.stage, message.requestId, {
      ...message.details, tabId: sender.tab?.id, frameId: sender.frameId,
    }, source).then((received) => sendResponse({ received }));
    return true;
  }

  if (message.type === "getDiagnostics") {
    if (sender.url !== chrome.runtime.getURL("popup/settings.html")) {
      sendResponse({ received: false });
      return false;
    }
    getDiagnostics().then((events) => sendResponse({ received: true, version: 1, events }))
      .catch(() => sendResponse({ received: false }));
    return true;
  }

  if (sender.tab) {
    message.sourceTabId = sender.tab.id;
    message.sourceWindowId = sender.tab.windowId;

    if (
      sender.tab.url.includes("learning.mheducation.com") ||
      sender.tab.url.includes("ezto.mheducation.com") ||
      sender.tab.url.includes("connect.mheducation.com")
    ) {
      if (!originalTabId && !duplicateTabId) {
        mheTabId = sender.tab.id;
        mheWindowId = sender.tab.windowId;
      }
    } else if (sender.tab.url.includes("chatgpt.com")) {
      aiTabId = sender.tab.id;
      aiWindowId = sender.tab.windowId;
      aiType = "chatgpt";
    } else if (sender.tab.url.includes("gemini.google.com")) {
      aiTabId = sender.tab.id;
      aiWindowId = sender.tab.windowId;
      aiType = "gemini";
    } else if (isDeepSeekTabUrl(sender.tab.url || "")) {
      aiTabId = sender.tab.id;
      aiWindowId = sender.tab.windowId;
      aiType = "deepseek";
    }
  }

  if (message.type === "ping") {
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "sendQuestionToChatGPT") {
    processQuestion(message)
      .then((result) => sendResponse(result || { received: true }))
      .catch((error) =>
        sendResponse({ received: false, error: error.message })
      );
    return true;
  }

  if (
    message.type === "chatGPTResponse" ||
    message.type === "geminiResponse" ||
    message.type === "deepseekResponse"
  ) {
    processResponse(message)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ received: false, error: error.message })
      );
    return true;
  }

  if (message.type === "createDuplicateTab") {
    originalTabId = sender.tab.id;
    storedResponse = pendingResponse;

    chrome.tabs.duplicate(sender.tab.id, async (newTab) => {
      duplicateTabId = newTab.id;

      const isReady = await waitForTabReady(duplicateTabId);

      if (isReady) {
        try {
          await sendMessageWithRetry(duplicateTabId, {
            type: "processDuplicateTab",
            response: storedResponse,
          });
        } catch (error) {
          console.error("Error sending message to duplicate tab:", error);
        }
      } else {
        console.error("Duplicate tab failed to become ready");
      }
    });
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "closeDuplicateTab") {
    if (duplicateTabId) {
      if (originalTabId) {
        focusTab(originalTabId);
      }

      chrome.tabs.remove(duplicateTabId, () => {
        duplicateTabId = null;
        isProcessingDuplicate = false;
      });
    }
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "finishDoubleCredit") {
    if (originalTabId) {
      sendMessageWithRetry(originalTabId, {
        type: "completeDoubleCredit",
      });
    }
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "resetTabTracking") {
    recordDiagnostic("request.cancel", message.requestId);
    queuedRestart = null;
    allowQueuedRestart = true;
    duplicateTabId = null;
    originalTabId = null;
    storedResponse = null;
    isProcessingDuplicate = false;
    pendingResponse = null;
    const cancelProvider =
      message.requestId && aiTabId
        ? sendMessageWithRetry(
            aiTabId,
            { type: "cancelRequest", requestId: message.requestId },
            1
          ).catch(() => null)
        : Promise.resolve();
    Promise.all([forgetRequest(message.requestId), cancelProvider])
      .then(() => sendResponse({ received: true }))
      .catch((error) =>
        sendResponse({ received: false, error: error.message })
      );
    return true;
  }

  if (message.type === "openSettings") {
    chrome.windows.create({
      url: chrome.runtime.getURL("popup/settings.html"),
      type: "popup",
      width: 500,
      height: 600,
    });
    sendResponse({ received: true });
    return true;
  }

  sendResponse({ received: false });
  return false;
});

findAndStoreTabs();

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === mheTabId) mheTabId = null;
  if (tabId === aiTabId) aiTabId = null;
  if (tabId === duplicateTabId) {
    duplicateTabId = null;
    isProcessingDuplicate = false;
  }
  if (tabId === originalTabId) {
    originalTabId = null;
    storedResponse = null;
  }
});
