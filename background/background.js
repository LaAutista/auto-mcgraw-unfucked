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
const DEEPSEEK_URL_PATTERNS = [
  "https://chat.deepseek.com/*",
];

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

async function focusTab(tabId) {
  if (!tabId) return false;

  try {
    const tab = await promiseApi.tabs.get(tabId);

    if (tab.windowId === chrome.windows.WINDOW_ID_CURRENT) {
      await promiseApi.tabs.update(tabId, { active: true });
      return true;
    }

    await promiseApi.windows.update(tab.windowId, { focused: true });
    await promiseApi.tabs.update(tabId, { active: true });
    return true;
  } catch (error) {
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
  return tabSwitchingEnabled !== false && mheWindowId === aiWindowId;
}

async function processQuestion(message) {
  if (processingQuestion) {
    if (allowQueuedRestart) queuedRestart = message;
    return;
  }
  processingQuestion = true;
  allowQueuedRestart = false;

  try {
    await findAndStoreTabs(message.sourceWindowId);
    mheTabId = message.sourceTabId;
    mheWindowId = message.sourceWindowId;
    const returnTabId = mheTabId;

    if (!aiTabId) {
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

    const switchTabs = await shouldFocusTabs();

    if (switchTabs) {
      await focusTab(aiTabId);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const aiResponse = await sendMessageWithRetry(aiTabId, {
      type: "receiveQuestion",
      requestId: crypto.randomUUID(),
      question: message.question,
    });

    if (
      aiResponse &&
      aiResponse.received === false &&
      !allowQueuedRestart &&
      !queuedRestart
    ) {
      await sendMessageWithRetry(mheTabId, {
        type: "alertMessage",
        message: `Could not enter the question into ${aiType}: ${
          aiResponse.error || "unknown error"
        }. Check the ${aiType} tab.`,
      });
      if (!allowQueuedRestart && !queuedRestart) {
        await sendMessageWithRetry(mheTabId, { type: "stopAutomation" });
      }
    }

    if (
      (await shouldFocusTabs()) &&
      returnTabId &&
      returnTabId !== aiTabId
    ) {
      await focusTab(returnTabId);
    }
  } catch (error) {
    if (mheTabId && !allowQueuedRestart && !queuedRestart) {
      await sendMessageWithRetry(mheTabId, {
        type: "alertMessage",
        message: `Error communicating with ${aiType}. Please make sure it's open in another tab.`,
      });
      if (!allowQueuedRestart && !queuedRestart) {
        await sendMessageWithRetry(mheTabId, { type: "stopAutomation" });
      }
    }
  } finally {
    processingQuestion = false;
    if (queuedRestart) {
      const nextQuestion = queuedRestart;
      queuedRestart = null;
      void processQuestion(nextQuestion);
    }
  }
}

async function processResponse(message) {
  try {
    pendingResponse = message.response;

    if (duplicateTabId && isProcessingDuplicate) {
      await sendMessageWithRetry(duplicateTabId, {
        type: "processChatGPTResponse",
        response: message.response,
        isDuplicateTab: true,
      });
      return;
    }

    if (originalTabId) {
      storedResponse = message.response;
      await sendMessageWithRetry(originalTabId, {
        type: "processChatGPTResponse",
        response: message.response,
        isDuplicateTab: false,
      });
      return;
    }

    if (!mheTabId) {
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
      } else {
        return;
      }
    }

    const switchTabs = await shouldFocusTabs();

    if (switchTabs) {
      await focusTab(mheTabId);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    await sendMessageWithRetry(mheTabId, {
      type: "processChatGPTResponse",
      response: message.response,
    });
  } catch (error) {
    console.error("Error processing AI response:", error);
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
    processQuestion(message);
    sendResponse({ received: true });
    return true;
  }

  if (
    message.type === "chatGPTResponse" ||
    message.type === "geminiResponse" ||
    message.type === "deepseekResponse"
  ) {
    processResponse(message);
    sendResponse({ received: true });
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
    queuedRestart = null;
    allowQueuedRestart = true;
    duplicateTabId = null;
    originalTabId = null;
    storedResponse = null;
    isProcessingDuplicate = false;
    pendingResponse = null;
    sendResponse({ received: true });
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
