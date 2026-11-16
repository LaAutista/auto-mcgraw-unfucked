document.addEventListener("DOMContentLoaded", function () {
  const statusMessage = document.getElementById("status-message");
  const footerVersionElement = document.getElementById("footer-version");

  footerVersionElement.textContent = `v${chrome.runtime.getManifest().version}`;

  document.getElementById("allow-question-images").addEventListener("click", async () => {
    const status = document.getElementById("image-permission-status");
    try {
      const allowed = await (globalThis.browser ?? chrome).permissions.request({
        origins: ["https://smartfactory-api.prod.mheducation.com/*"],
      });
      status.textContent = allowed ? "Question image access enabled." : "Image access was not enabled.";
    } catch {
      status.textContent = "Could not request image access. Check this add-on's site permissions in Firefox.";
    }
  });

  document.getElementById("export-diagnostics").addEventListener("click", async () => {
    const status = document.getElementById("diagnostics-status");
    try {
      const result = await (globalThis.browser ?? chrome).runtime.sendMessage({ type: "getDiagnostics" });
      if (!result?.received) throw new Error("Diagnostic export unavailable");
      const blob = new Blob([JSON.stringify({ extensionVersion: chrome.runtime.getManifest().version, ...result }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `auto-mcgraw-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = `Saved ${result.events.length} diagnostic events.`;
    } catch {
      status.textContent = "Could not save diagnostics. Reopen settings and try again.";
    }
  });

  const tabSwitchingToggle = document.getElementById("tab-switching-toggle");
  const randomConfidenceToggle = document.getElementById("random-confidence-toggle");
  const pauseBeforeSubmitToggle = document.getElementById("pause-before-submit-toggle");

  chrome.storage.sync.get(
    [
      "tabSwitchingEnabled",
      "randomConfidence",
      "pauseBeforeSubmit",
    ],
    function (data) {
      tabSwitchingToggle.checked = data.tabSwitchingEnabled !== false;
      randomConfidenceToggle.checked = data.randomConfidence || false;
      pauseBeforeSubmitToggle.checked = data.pauseBeforeSubmit || false;
    }
  );

  tabSwitchingToggle.addEventListener("change", function () {
    chrome.storage.sync.set({ tabSwitchingEnabled: this.checked });
  });

  randomConfidenceToggle.addEventListener("change", function () {
    chrome.storage.sync.set({ randomConfidence: this.checked });
  });

  pauseBeforeSubmitToggle.addEventListener("change", function () {
    chrome.storage.sync.set({ pauseBeforeSubmit: this.checked });
  });

  function checkChatGPT() {
    chrome.tabs.query({ url: "https://chatgpt.com/*" }, (tabs) => {
      statusMessage.textContent = tabs.length ? "ChatGPT tab is open." : "Open ChatGPT in another tab.";
      statusMessage.className = tabs.length ? "success" : "error";
    });
  }

  checkChatGPT();
  setInterval(checkChatGPT, 5000);
});
