function agentOverlayRuntime(payload) {
  const stateKey = "__cursorAgentOverlayState";
  const styleId = "__cursor-agent-overlay-style";
  const cardId = "__cursor-agent-progress-card";
  const blockerId = "__cursor-agent-click-blocker";

  const getState = () => {
    if (!window[stateKey]) {
      window[stateKey] = {
        text: "Agent in progress",
        disableClicks: true,
        locked: true
      };
    }
    return window[stateKey];
  };

  const ensureStyle = () => {
    if (document.getElementById(styleId)) return;
    const styleEl = document.createElement("style");
    styleEl.id = styleId;
    styleEl.textContent = `
      #${blockerId} {
        position: fixed;
        inset: 0;
        background: transparent;
        z-index: 2147483646;
        display: none;
        cursor: wait;
      }
      #${cardId} {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        background: rgba(17, 24, 39, 0.92);
        color: #fff;
        border-radius: 10px;
        padding: 10px 14px;
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.28);
        font-family: Arial, sans-serif;
        font-size: 13px;
        line-height: 1.3;
        pointer-events: none;
      }
    `;
    document.head.appendChild(styleEl);
  };

  const ensureNodes = () => {
    if (!document.body) return;
    ensureStyle();

    let blocker = document.getElementById(blockerId);
    if (!blocker) {
      blocker = document.createElement("div");
      blocker.id = blockerId;
      document.body.appendChild(blocker);
    }

    let card = document.getElementById(cardId);
    if (!card) {
      card = document.createElement("div");
      card.id = cardId;
      document.body.appendChild(card);
    }

    const state = getState();
    card.textContent = state.text;
    blocker.style.display = state.disableClicks && state.locked ? "block" : "none";
  };

  const removeNodes = () => {
    const blocker = document.getElementById(blockerId);
    if (blocker) blocker.remove();
    const card = document.getElementById(cardId);
    if (card) card.remove();
    const styleEl = document.getElementById(styleId);
    if (styleEl) styleEl.remove();
    delete window[stateKey];
  };

  const mountNowOrOnReady = () => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", ensureNodes, { once: true });
    } else {
      ensureNodes();
    }
  };

  if (payload && payload.command === "remove") {
    removeNodes();
    return;
  }

  const state = getState();
  if (payload && payload.command === "setup") {
    const options = payload.options || {};
    state.text = String(options.text || "Agent in progress");
    state.disableClicks = Boolean(options.disableClicks);
    if (typeof options.locked === "boolean") {
      state.locked = options.locked;
    }
    mountNowOrOnReady();
    return;
  }

  if (payload && payload.command === "set-locked") {
    state.locked = Boolean(payload.locked);
    mountNowOrOnReady();
  }
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

async function setupAgentOverlay(page, { text, disableClicks, lockOnStart }) {
  const options = {
    text: text || "Agent in progress",
    disableClicks: Boolean(disableClicks),
    locked: Boolean(lockOnStart)
  };
  const budgetMs = 8000
  await withTimeout(
    page.addInitScript(agentOverlayRuntime, {
      command: "setup",
      options
    }),
    budgetMs,
    "agent overlay addInitScript"
  )
  await withTimeout(
    page.evaluate(agentOverlayRuntime, {
      command: "setup",
      options
    }),
    budgetMs,
    "agent overlay evaluate"
  )
}

async function setAgentOverlayLocked(page, locked) {
  try {
    await withTimeout(
      page.evaluate(agentOverlayRuntime, {
        command: "set-locked",
        locked: Boolean(locked)
      }),
      8000,
      "agent overlay lock"
    )
  } catch {
    // SPA navigations (goto) can leave evaluate hung; do not fail the action.
  }
}

async function removeAgentOverlay(page) {
  try {
    await withTimeout(
      page.evaluate(agentOverlayRuntime, {
        command: "remove"
      }),
      8000,
      "agent overlay remove"
    )
  } catch {
    // Best-effort cleanup after navigation / closed page.
  }
}

module.exports = {
  setupAgentOverlay,
  setAgentOverlayLocked,
  removeAgentOverlay
};

