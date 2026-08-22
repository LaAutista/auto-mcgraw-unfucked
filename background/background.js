let mheTabId = null;
let aiTabId = null;
let aiType = null;
let lastActiveTabId = null;
let processingQuestion = false;
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

chrome.tabs.onActivated.addListener((activeInfo) => {
  lastActiveTabId = activeInfo.tabId;
});

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

async function findAndStoreTabs() {
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
    if (tabs.length > 0) {
      aiTabId = tabs[0].id;
      aiWindowId = tabs[0].windowId;
    } else {
      aiTabId = null;
    }
  } else if (aiModel === "gemini") {
    const tabs = await promiseApi.tabs.query({
      url: "https://gemini.google.com/*",
    });
    if (tabs.length > 0) {
      aiTabId = tabs[0].id;
      aiWindowId = tabs[0].windowId;
    } else {
      aiTabId = null;
    }
  } else if (aiModel === "deepseek") {
    const tabs = await promiseApi.tabs.query({
      url: DEEPSEEK_URL_PATTERNS,
    });
    if (tabs.length > 0) {
      const preferredTab =
        tabs.find((tab) => tab.url && tab.url.includes("chat.deepseek.com")) ||
        tabs[0];
      aiTabId = preferredTab.id;
      aiWindowId = preferredTab.windowId;
    } else {
      aiTabId = null;
    }
  }
}

function shouldFocusTabs() {
  return mheWindowId === aiWindowId;
}

async function processQuestion(message) {
  if (processingQuestion) return;
  processingQuestion = true;

  try {
    await findAndStoreTabs();
    mheTabId = message.sourceTabId;
    mheWindowId = message.sourceWindowId;

    if (!aiTabId) {
      await sendMessageWithRetry(mheTabId, {
        type: "alertMessage",
        message: `Please open ${aiType} in another tab before using automation.`,
      });
      await sendMessageWithRetry(mheTabId, {
        type: "stopAutomation",
      });
      processingQuestion = false;
      return;
    }

    const sameWindow = await shouldFocusTabs();

    if (sameWindow) {
      await focusTab(aiTabId);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const aiResponse = await sendMessageWithRetry(aiTabId, {
      type: "receiveQuestion",
      question: message.question,
    });

    if (aiResponse && aiResponse.received === false) {
      await sendMessageWithRetry(mheTabId, {
        type: "alertMessage",
        message: `Could not enter the question into ${aiType}: ${
          aiResponse.error || "unknown error"
        }. Check the ${aiType} tab.`,
      });
      await sendMessageWithRetry(mheTabId, { type: "stopAutomation" });
    }

    if (sameWindow && lastActiveTabId && lastActiveTabId !== aiTabId) {
      setTimeout(async () => {
        await focusTab(lastActiveTabId);
      }, 1000);
    }
  } catch (error) {
    if (mheTabId) {
      await sendMessageWithRetry(mheTabId, {
        type: "alertMessage",
        message: `Error communicating with ${aiType}. Please make sure it's open in another tab.`,
      });
      await sendMessageWithRetry(mheTabId, {
        type: "stopAutomation",
      });
    }
  } finally {
    processingQuestion = false;
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

    const sameWindow = await shouldFocusTabs();

    if (sameWindow) {
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
