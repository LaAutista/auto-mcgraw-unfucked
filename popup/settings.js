document.addEventListener("DOMContentLoaded", function () {
  const DEEPSEEK_URL_PATTERNS = [
    "https://chat.deepseek.com/*",
  ];
  const chatgptButton = document.getElementById("chatgpt");
  const geminiButton = document.getElementById("gemini");
  const deepseekButton = document.getElementById("deepseek");
  const statusMessage = document.getElementById("status-message");
  const footerVersionElement = document.getElementById("footer-version");

  footerVersionElement.textContent = `v${chrome.runtime.getManifest().version}`;

  chrome.storage.sync.get("aiModel", function (data) {
    const currentModel = data.aiModel || "chatgpt";

    chatgptButton.classList.remove("active");
    geminiButton.classList.remove("active");
    deepseekButton.classList.remove("active");

    if (currentModel === "chatgpt") {
      chatgptButton.classList.add("active");
    } else if (currentModel === "gemini") {
      geminiButton.classList.add("active");
    } else if (currentModel === "deepseek") {
      deepseekButton.classList.add("active");
    }

    checkModelAvailability(currentModel);
  });

  chatgptButton.addEventListener("click", function () {
    setActiveModel("chatgpt");
  });

  geminiButton.addEventListener("click", function () {
    setActiveModel("gemini");
  });

  deepseekButton.addEventListener("click", function () {
    setActiveModel("deepseek");
  });

  function setActiveModel(model) {
    chrome.storage.sync.set({ aiModel: model }, function () {
      chatgptButton.classList.remove("active");
      geminiButton.classList.remove("active");
      deepseekButton.classList.remove("active");

      if (model === "chatgpt") {
        chatgptButton.classList.add("active");
      } else if (model === "gemini") {
        geminiButton.classList.add("active");
      } else if (model === "deepseek") {
        deepseekButton.classList.add("active");
      }

      checkModelAvailability(model);
    });
  }

  const tabSwitchingToggle = document.getElementById("tab-switching-toggle");
  const doubleCreditToggle = document.getElementById("double-credit-toggle");
  const randomConfidenceToggle = document.getElementById("random-confidence-toggle");
  const pauseBeforeSubmitToggle = document.getElementById("pause-before-submit-toggle");

  chrome.storage.sync.get(
    [
      "tabSwitchingEnabled",
      "doubleCreditMode",
      "randomConfidence",
      "pauseBeforeSubmit",
    ],
    function (data) {
      tabSwitchingToggle.checked = data.tabSwitchingEnabled !== false;
      doubleCreditToggle.checked = data.doubleCreditMode || false;
      randomConfidenceToggle.checked = data.randomConfidence || false;
      pauseBeforeSubmitToggle.checked = data.pauseBeforeSubmit || false;
    }
  );

  tabSwitchingToggle.addEventListener("change", function () {
    chrome.storage.sync.set({ tabSwitchingEnabled: this.checked });
  });

  doubleCreditToggle.addEventListener("change", function () {
    chrome.storage.sync.set({ doubleCreditMode: this.checked });
  });

  randomConfidenceToggle.addEventListener("change", function () {
    chrome.storage.sync.set({ randomConfidence: this.checked });
  });

  pauseBeforeSubmitToggle.addEventListener("change", function () {
    chrome.storage.sync.set({ pauseBeforeSubmit: this.checked });
  });

  function checkModelAvailability(currentModel) {
    statusMessage.textContent = "Checking assistant availability...";
    statusMessage.className = "";

    chrome.tabs.query({ url: "https://chatgpt.com/*" }, (chatgptTabs) => {
      const chatgptAvailable = chatgptTabs.length > 0;

      chrome.tabs.query(
        { url: "https://gemini.google.com/*" },
        (geminiTabs) => {
          const geminiAvailable = geminiTabs.length > 0;

          chrome.tabs.query(
            { url: DEEPSEEK_URL_PATTERNS },
            (deepseekTabs) => {
              const deepseekAvailable = deepseekTabs.length > 0;

              if (currentModel === "chatgpt") {
                if (chatgptAvailable) {
                  statusMessage.textContent =
                    "ChatGPT tab is open and ready to use.";
                  statusMessage.className = "success";
                } else {
                  statusMessage.textContent =
                    "Please open ChatGPT in another tab to use this assistant.";
                  statusMessage.className = "error";
                }
              } else if (currentModel === "gemini") {
                if (geminiAvailable) {
                  statusMessage.textContent =
                    "Gemini tab is open and ready to use.";
                  statusMessage.className = "success";
                } else {
                  statusMessage.textContent =
                    "Please open Gemini in another tab to use this assistant.";
                  statusMessage.className = "error";
                }
              } else if (currentModel === "deepseek") {
                if (deepseekAvailable) {
                  statusMessage.textContent =
                    "DeepSeek tab is open and ready to use.";
                  statusMessage.className = "success";
                } else {
                  statusMessage.textContent =
                    "Please open DeepSeek in another tab to use this assistant.";
                  statusMessage.className = "error";
                }
              }
            }
          );
        }
      );
    });
  }

  setInterval(() => {
    chrome.storage.sync.get("aiModel", function (data) {
      const currentModel = data.aiModel || "chatgpt";
      checkModelAvailability(currentModel);
    });
  }, 5000);

});
