console.log("[Auto-McGraw][deepseek] content script LOADED — marker v2");
let hasResponded = false;
let currentQuestionSignature = null;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let pollIntervalId = null;
let observer = null;
const MESSAGE_SELECTORS = [
  "[data-testid='chat-message-assistant']",
  "[data-testid='message-content']",
  "model-response",
  ".ds-markdown",
  ".f9bf7997",
];
const CHAT_INPUT_SELECTORS = [
  "#chat-input",
  'textarea[data-testid="chat_input_input"]',
  "textarea",
  '[role="textbox"][contenteditable="true"]',
];
const SEND_BUTTON_SELECTORS = [
  '[data-testid="submit-button"]',
  '[data-testid="send-button"]',
  '[data-testid="chat_input_send_button"]',
  '[role="button"].f6d670',
  ".f6d670",
  'button[type="submit"]',
  '[aria-label="Send message"]',
  '[aria-label*="Send"]',
  ".bf38813a button",
];

function getMessageNodes() {
  for (const selector of MESSAGE_SELECTORS) {
    const nodes = document.querySelectorAll(selector);
    if (nodes.length > 0) {
      return Array.from(nodes);
    }
  }

  return [];
}

function findChatInput() {
  for (const selector of CHAT_INPUT_SELECTORS) {
    const input = document.querySelector(selector);
    if (input) {
      return input;
    }
  }

  return null;
}

function isButtonUsable(button) {
  if (!button) return false;
  if (button.disabled) return false;
  if (button.getAttribute("aria-disabled") === "true") return false;
  return true;
}

function findSendButton() {
  for (const selector of SEND_BUTTON_SELECTORS) {
    try {
      const button = document.querySelector(selector);
      if (isButtonUsable(button)) {
        return button;
      }
    } catch (e) {
      continue;
    }
  }

  const composerContainer = document.querySelector(".bf38813a");
  if (composerContainer) {
    const candidates = Array.from(
      composerContainer.querySelectorAll("button, [role='button']")
    );
    const lastEnabled = candidates.reverse().find((button) => isButtonUsable(button));
    if (lastEnabled) {
      return lastEnabled;
    }
  }

  return null;
}

// Poll for a usable send button instead of guessing a fixed delay. Resolves
// with the element once it appears, or null on timeout.
function waitForSendButton(timeout = 12000, interval = 150) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const button = findSendButton();
      if (button) return resolve(button);
      if (Date.now() - start > timeout) return resolve(null);
      setTimeout(tick, interval);
    };
    tick();
  });
}

function updateChatInputValue(chatInput, text) {
  chatInput.focus();

  if (
    chatInput instanceof HTMLTextAreaElement ||
    chatInput instanceof HTMLInputElement
  ) {
    const prototype = Object.getPrototypeOf(chatInput);
    const valueSetter = Object.getOwnPropertyDescriptor(
      prototype,
      "value"
    )?.set;

    if (valueSetter) {
      valueSetter.call(chatInput, text);
    } else {
      chatInput.value = text;
    }
  } else if (chatInput.isContentEditable) {
    chatInput.textContent = text;
  } else {
    return false;
  }

  chatInput.dispatchEvent(new Event("input", { bubbles: true }));
  chatInput.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "receiveQuestion") {
    const signature = JSON.stringify(message.question);

    // The background script retries sends; ignore a duplicate of the question
    // we're already working on so it can't corrupt our "prior answer" baseline.
    if (currentQuestionSignature === signature && pollIntervalId && !hasResponded) {
      sendResponse({ received: true, status: "already-processing" });
      return true;
    }

    currentQuestionSignature = signature;
    resetObservation();

    messageCountAtQuestion = getMessageNodes().length;
    hasResponded = false;

    insertQuestion(message.question)
      .then(() => {
        sendResponse({ received: true, status: "processing" });
      })
      .catch((error) => {
        sendResponse({ received: false, error: error.message });
      });

    return true;
  }
});

function resetObservation() {
  hasResponded = false;
  if (observationTimeout) {
    clearTimeout(observationTimeout);
    observationTimeout = null;
  }
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

async function insertQuestion(questionData) {
  const { type, question, options, previousCorrection } = questionData;
  let text = `Type: ${type}\nQuestion: ${question}`;

  if (
    previousCorrection &&
    previousCorrection.question &&
    previousCorrection.correctAnswer
  ) {
    text =
      `CORRECTION FROM PREVIOUS ANSWER: For the question "${
        previousCorrection.question
      }", your answer was incorrect. The correct answer was: ${JSON.stringify(
        previousCorrection.correctAnswer
      )}\n\nNow answer this new question:\n\n` + text;
  }

  if (type === "matching") {
    text +=
      "\nPrompts:\n" +
      options.prompts.map((prompt, i) => `${i + 1}. ${prompt}`).join("\n");
    text +=
      "\nChoices:\n" +
      options.choices.map((choice, i) => `${i + 1}. ${choice}`).join("\n");
    text +=
      '\n\nPlease match each prompt with the correct choice. Set "answer" to an array of strings using the exact format \'Prompt -> Choice\'. Include one entry per prompt, use exact prompt and choice text, and use each choice at most once.';
  } else if (type === "fill_in_the_blank") {
    text +=
      "\n\nThis is a fill in the blank question. If there are multiple blanks, provide answers as an array in order of appearance. For a single blank, you can provide a string.";
  } else if (type === "sim_choice") {
    text +=
      "\nResponse options:\n" +
      options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      '\n\nThis is an interactive business simulation played as a chat conversation. You are playing the student\'s role. Choose the single best response option for the situation. Set "answer" to the exact text of the best option.';
  } else if (type === "worksheet_mc") {
    text +=
      "\nItems:\n" +
      options.items.map((item, i) => `${i + 1}. ${item}`).join("\n");
    text +=
      "\nChoices (the same choices apply to every item):\n" +
      options.choices.map((choice, i) => `${i + 1}. ${choice}`).join("\n");
    text +=
      '\n\nAssign exactly one choice to each item. Set "answer" to an array with one choice per item, in the same order as the items, using the exact choice text.';
  } else if (type === "ranking") {
    text +=
      "\nItems to rank:\n" +
      options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      '\n\nThis is a ranking question. Set "answer" to an array containing ALL of the above items in the correct order from first to last. Use the exact item text.';
  } else if (type === "multiple_response") {
    text +=
      "\nOptions:\n" +
      options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      '\n\nThis is a "select all that apply" question. Set "answer" to an array containing ALL of the correct options. Use the exact option text.';
  } else if (options && options.length > 0) {
    text +=
      "\nOptions:\n" + options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      "\n\nIMPORTANT: Your answer must EXACTLY match the above options. Do not include numbers in your answer. If there are periods, include them. If there are multiple selections, include all of the correct selections.";
  }

  text +=
    '\n\nIMPORTANT: Your answer should be in a JSON code block.' +
    '\n\nPlease provide your answer in JSON format with keys "answer" and "explanation". Explanations should be no more than one sentence. DO NOT acknowledge the correction in your response, only answer the new question.';

  const chatInput = findChatInput();
  if (!chatInput) throw new Error("Input area not found");

  await submitToComposer(chatInput, text);
  startObserving();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pressEnter(inputArea) {
  inputArea.focus();
  const opts = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  inputArea.dispatchEvent(new KeyboardEvent("keydown", opts));
  inputArea.dispatchEvent(new KeyboardEvent("keyup", opts));
}

function getComposerText(chatInput) {
  if (
    chatInput instanceof HTMLTextAreaElement ||
    chatInput instanceof HTMLInputElement
  ) {
    return chatInput.value || "";
  }
  return chatInput.innerText || chatInput.textContent || "";
}

// Did the message actually go out? The composer clears on send.
function looksSent(chatInput) {
  return getComposerText(chatInput).trim().length === 0;
}

// Type the question and reliably submit it, even when a long/heavy chat makes
// the composer slow to become ready. Waits for the send button, verifies the
// send, falls back to Enter, and retries before giving up.
async function submitToComposer(chatInput, text) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!updateChatInputValue(chatInput, text)) {
      throw new Error("Unable to fill input area");
    }

    const sendButton = await waitForSendButton(12000);
    if (sendButton) {
      sendButton.click();
    } else {
      console.warn(
        "[Auto-McGraw][deepseek] Send button never appeared (attempt " +
          attempt +
          "); trying Enter key."
      );
      pressEnter(chatInput);
    }

    await sleep(600);
    if (looksSent(chatInput)) return;

    console.warn(
      "[Auto-McGraw][deepseek] Submit attempt " +
        attempt +
        " didn't go through; retrying."
    );
    await sleep(800);
  }

  throw new Error("Could not submit question to DeepSeek after 3 attempts");
}

// Pull a parseable JSON answer out of the latest assistant message.
// Returns the JSON string if found, or null while the model is still
// thinking / streaming.
function getLatestAnswerJson() {
  const messages = getMessageNodes();
  if (messages.length <= messageCountAtQuestion) return null;

  const latestMessage = messages[messages.length - 1];

  const candidates = [];

  // Prefer fenced code blocks (that's where the JSON normally lands).
  latestMessage
    .querySelectorAll("pre code, pre")
    .forEach((block) => {
      candidates.push(block.textContent);
    });

  // Fall back to scanning the whole message for a JSON object.
  const fullText = latestMessage.textContent || "";
  const objectMatch = fullText.match(/\{[\s\S]*"answer"[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);

  for (let candidate of candidates) {
    candidate = candidate
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\n\s*/g, " ")
      .trim();

    // Skip placeholders and anything not shaped like JSON.
    if (!candidate.startsWith("{")) continue;

    try {
      const parsed = JSON.parse(candidate);
      if (parsed && parsed.answer !== undefined) {
        return candidate;
      }
    } catch (e) {
      // Likely still streaming — keep waiting for the full object.
    }
  }

  return null;
}

function tryHandleResponse() {
  if (hasResponded) return;

  const responseText = getLatestAnswerJson();
  if (!responseText) return;

  hasResponded = true;
  console.log("[Auto-McGraw][deepseek] sending answer back:", responseText);
  chrome.runtime
    .sendMessage({
      type: "deepseekResponse",
      response: responseText,
    })
    .then(() => {
      resetObservation();
    })
    .catch((error) => {
      console.error("[Auto-McGraw][deepseek] Error sending response:", error);
    });
}

function startObserving() {
  observationStartTime = Date.now();
  observationTimeout = setTimeout(() => {
    if (!hasResponded) {
      console.warn("[Auto-McGraw][deepseek] Gave up waiting for a JSON answer.");
      resetObservation();
    }
  }, 180000);

  // Poll instead of relying on a single mutation firing at the right moment.
  // Reasoning models render their chain-of-thought first, then the real
  // answer later; polling keeps checking until valid JSON with an "answer"
  // field appears.
  pollIntervalId = setInterval(tryHandleResponse, 800);

  // Mutation observer gives a faster response when the answer streams in.
  observer = new MutationObserver(() => {
    tryHandleResponse();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
}
