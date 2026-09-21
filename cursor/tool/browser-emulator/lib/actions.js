function isRecoverableNavigationError(error) {
  const message = String((error && error.message) || error || "");
  return message.includes("Execution context was destroyed")
    || message.includes("Target closed")
    || message.includes("Navigation interrupted");
}

async function runWithNavigationRetry(page, fn) {
  try {
    return await fn();
  } catch (error) {
    if (!isRecoverableNavigationError(error)) throw error;
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    return fn();
  }
}

function isOverlayInterceptionError(error) {
  const message = String((error && error.message) || error || "");
  return message.includes("intercepts pointer events")
    && (message.includes("v-overlay__scrim") || message.includes("v-overlay-container"));
}

async function dismissOverlayScrim(page, timeoutMs) {
  const quickTimeout = Math.max(500, Math.min(Number(timeoutMs || 3000), 1500));
  const selectors = [
    ".v-overlay__scrim",
    ".v-overlay-container .v-overlay__scrim"
  ];

  for (const selector of selectors) {
    const scrim = page.locator(selector).first();
    const visible = await scrim.isVisible({ timeout: 250 }).catch(() => false);
    if (!visible) continue;
    await scrim.click({ timeout: quickTimeout }).catch(() => {});
    await page.waitForTimeout(120);
    return true;
  }

  return false;
}

async function findVisibleLocator(page, selector, timeoutMs) {
  const locator = page.locator(selector);
  const startedAt = Date.now();
  const maxScan = 20;

  while (Date.now() - startedAt < timeoutMs) {
    const count = await locator.count().catch(() => 0);
    const scanCount = Math.min(count, maxScan);

    for (let i = 0; i < scanCount; i += 1) {
      const candidate = locator.nth(i);
      const visible = await candidate.isVisible({ timeout: 75 }).catch(() => false);
      if (visible) {
        return candidate;
      }
    }

    await page.waitForTimeout(80);
  }

  // Keep old behavior fallback for single/hidden selectors.
  return locator.first();
}

async function findClickableLocator(page, selector, timeoutMs) {
  const primary = await findVisibleLocator(page, selector, timeoutMs);
  const primaryVisible = await primary.isVisible({ timeout: 75 }).catch(() => false);
  if (primaryVisible) return primary;

  const hasTextValue = extractHasTextValue(selector);
  if (!hasTextValue) return primary;

  const fallbacks = [
    `.v-list-item:has-text("${hasTextValue}")`,
    `button:has-text("${hasTextValue}")`,
    `[role="menuitem"]:has-text("${hasTextValue}")`
  ];
  const fallbackTimeout = Math.max(400, Math.min(Number(timeoutMs || 1500), 1500));

  for (const fallback of fallbacks) {
    if (fallback === selector) continue;
    const candidate = await findVisibleLocator(page, fallback, fallbackTimeout);
    const visible = await candidate.isVisible({ timeout: 75 }).catch(() => false);
    if (visible) return candidate;
  }

  return primary;
}

function normalizeLooseText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

async function clickByLooseTextFallback(page, rawText) {
  const target = normalizeLooseText(rawText);
  if (!target) return false;

  return page.evaluate((targetText) => {
    const normalize = (value) => String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0
        && rect.height > 0
        && style.visibility !== "hidden"
        && style.display !== "none";
    };
    const candidates = Array.from(
      document.querySelectorAll("a,button,[role='button'],.v-list-item,.nav-item-title,.v-list-item-title,.nav-link,span,div")
    );
    for (const el of candidates) {
      const text = normalize(el.textContent);
      if (!text || !text.includes(targetText)) continue;
      if (!isVisible(el)) continue;
      const clickable = el.closest("a,button,[role='button'],li,.nav-link,.v-list-item,.v-btn,div") || el;
      if (!isVisible(clickable)) continue;
      clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    }
    return false;
  }, target);
}

function extractHasTextValue(selector) {
  const raw = String(selector || "");
  const match = raw.match(/:has-text\((['"])(.*?)\1\)/);
  return match ? String(match[2] || "").trim() : "";
}

async function verifyActionExpectations(page, action, timeoutMs, beforeDom = "") {
  const expectSelector = String(action.expectSelector || "").trim();
  const expectUrlIncludes = String(action.expectUrlIncludes || "").trim();
  const expectDomChange = String(action.expectDomChange || "").trim().toLowerCase() === "true";

  if (expectSelector) {
    const expectedLocator = await findVisibleLocator(page, expectSelector, timeoutMs);
    await expectedLocator.waitFor({ state: "visible", timeout: timeoutMs });
  }

  if (expectUrlIncludes) {
    const currentUrl = String(page.url() || "");
    if (!currentUrl.includes(expectUrlIncludes)) {
      throw new Error(`Action expectation failed: URL must include '${expectUrlIncludes}', got '${currentUrl}'.`);
    }
  }

  if (expectDomChange) {
    const afterDom = await page.content();
    if (beforeDom && afterDom === beforeDom) {
      throw new Error("Action expectation failed: expected DOM change, but page content is unchanged.");
    }
  }
}

async function runHoldForUserAnswer(page, action, timeoutMs) {
  const zoneSelector = String(action.selector || "").trim();
  const prompt = String(
    action.prompt
    || action.instruction
    || action.value
    || "Please annotate the edited zone, then submit feedback."
  ).trim();
  const toolbarTitle = String(action.toolbarTitle || "Agent Hold Mode").trim();
  const submitLabel = String(action.submitLabel || "Submit to Agent").trim();
  const acceptLabel = String(action.acceptLabel || "Accept Done").trim();
  const placeholder = String(action.placeholder || "Type your feedback for the agent...").trim();
  const requireNote = String(action.requireNote || "").trim().toLowerCase() === "true";
  const fullScreenEditRaw = action.fullScreenEdit ?? action.allowFullScreenEdit;
  const fullScreenEdit = String(
    fullScreenEditRaw === undefined ? "true" : fullScreenEditRaw
  ).trim().toLowerCase() !== "false";
  const requestedDrawScope = String(action.drawScope || "").trim().toLowerCase();
  // Default draw scope is full-screen unless explicitly forced to zone.
  const initialDrawScope = requestedDrawScope === "zone" ? "zone" : "full";
  const MIN_HOLD_TIMEOUT_MS = 60000;
  const DEFAULT_HOLD_TIMEOUT_MS = 600000;
  const rawHoldTimeoutMs = Number(action.holdTimeoutMs);
  const requestedHoldTimeoutMs = Number.isFinite(rawHoldTimeoutMs) && rawHoldTimeoutMs > 0
    ? rawHoldTimeoutMs
    : DEFAULT_HOLD_TIMEOUT_MS;
  const holdTimeoutMs = Math.max(MIN_HOLD_TIMEOUT_MS, requestedHoldTimeoutMs);

  const zoneResult = await page.evaluate(
    ({ zoneSelector: selector }) => {
      let zoneFound = false;
      let zoneRect = null;
      if (selector) {
        const el = document.querySelector(selector);
        if (el) {
          zoneFound = true;
          el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
          const rect = el.getBoundingClientRect();
          zoneRect = {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        }
      }
      return { zoneFound, zoneRect };
    },
    { zoneSelector }
  );

  await page.evaluate(
    ({ zoneSelector: selector, promptText, toolbarTitleText, submitText, acceptText, inputPlaceholder, noteRequired, allowFullScreenEdit, initialDrawScope }) => {
      const existing = window.__browserEmulatorHold;
      if (existing && typeof existing.cleanup === "function") {
        existing.cleanup();
      }

      const overlayRoot = document.createElement("div");
      overlayRoot.id = "__browser-emulator-hold-root";
      overlayRoot.style.position = "fixed";
      overlayRoot.style.inset = "0";
      overlayRoot.style.zIndex = "2147483646";
      overlayRoot.style.pointerEvents = "none";

      const canvas = document.createElement("canvas");
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      canvas.style.position = "fixed";
      canvas.style.inset = "0";
      canvas.style.width = "100vw";
      canvas.style.height = "100vh";
      canvas.style.pointerEvents = "none";
      canvas.style.cursor = "default";
      canvas.style.touchAction = "none";
      overlayRoot.appendChild(canvas);

      const toolbar = document.createElement("div");
      toolbar.style.position = "fixed";
      toolbar.style.left = "12px";
      toolbar.style.right = "12px";
      toolbar.style.top = "12px";
      toolbar.style.bottom = "auto";
      toolbar.style.maxHeight = "calc(100vh - 24px)";
      toolbar.style.overflow = "auto";
      toolbar.style.background = "rgba(20, 24, 31, 0.97)";
      toolbar.style.color = "#e5e7eb";
      toolbar.style.border = "1px solid rgba(255, 255, 255, 0.16)";
      toolbar.style.borderRadius = "10px";
      toolbar.style.padding = "8px 10px";
      toolbar.style.boxShadow = "0 10px 28px rgba(0,0,0,0.38)";
      toolbar.style.fontFamily = "Segoe UI, Arial, sans-serif";
      toolbar.style.pointerEvents = "auto";
      toolbar.style.zIndex = "2147483647";
      overlayRoot.appendChild(toolbar);

      const titleRow = document.createElement("div");
      titleRow.style.display = "flex";
      titleRow.style.alignItems = "center";
      titleRow.style.justifyContent = "space-between";
      titleRow.style.gap = "8px";
      titleRow.style.marginBottom = "4px";
      titleRow.style.cursor = "move";
      titleRow.style.userSelect = "none";
      titleRow.style.touchAction = "none";
      toolbar.appendChild(titleRow);

      const title = document.createElement("div");
      title.textContent = toolbarTitleText;
      title.style.fontWeight = "700";
      title.style.fontSize = "13px";
      titleRow.appendChild(title);

      const dragHint = document.createElement("div");
      dragHint.textContent = "Drag toolbar";
      dragHint.style.fontSize = "10px";
      dragHint.style.color = "rgba(229, 231, 235, 0.68)";
      titleRow.appendChild(dragHint);

      let toolbarDragged = false;
      let toolbarDragActive = false;
      let toolbarDragStartX = 0;
      let toolbarDragStartY = 0;
      let toolbarStartLeft = 0;
      let toolbarStartTop = 0;
      const setToolbarPosition = (nextLeft, nextTop) => {
        const width = Math.max(220, toolbar.offsetWidth || 220);
        const height = Math.max(140, toolbar.offsetHeight || 140);
        const maxLeft = Math.max(12, window.innerWidth - width - 12);
        const maxTop = Math.max(12, window.innerHeight - height - 12);
        const clampedLeft = Math.min(Math.max(12, nextLeft), maxLeft);
        const clampedTop = Math.min(Math.max(12, nextTop), maxTop);
        toolbar.style.left = `${Math.round(clampedLeft)}px`;
        toolbar.style.top = `${Math.round(clampedTop)}px`;
        toolbar.style.right = "auto";
        toolbar.style.bottom = "auto";
      };
      const onToolbarDragMove = (event) => {
        if (!toolbarDragActive) return;
        event.preventDefault();
        const dx = event.clientX - toolbarDragStartX;
        const dy = event.clientY - toolbarDragStartY;
        setToolbarPosition(toolbarStartLeft + dx, toolbarStartTop + dy);
      };
      const onToolbarDragEnd = () => {
        if (!toolbarDragActive) return;
        toolbarDragActive = false;
        window.removeEventListener("pointermove", onToolbarDragMove);
        window.removeEventListener("pointerup", onToolbarDragEnd);
      };
      titleRow.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        toolbarDragged = true;
        toolbarDragActive = true;
        toolbarDragStartX = event.clientX;
        toolbarDragStartY = event.clientY;
        const rect = toolbar.getBoundingClientRect();
        toolbarStartLeft = rect.left;
        toolbarStartTop = rect.top;
        titleRow.setPointerCapture?.(event.pointerId);
        window.addEventListener("pointermove", onToolbarDragMove);
        window.addEventListener("pointerup", onToolbarDragEnd);
      });

      const promptEl = document.createElement("div");
      promptEl.textContent = promptText;
      promptEl.style.fontSize = "12px";
      promptEl.style.lineHeight = "1.4";
      promptEl.style.color = "rgba(229, 231, 235, 0.9)";
      promptEl.style.marginBottom = "6px";
      toolbar.appendChild(promptEl);

      const ribbon = document.createElement("div");
      ribbon.style.display = "flex";
      ribbon.style.flexWrap = "wrap";
      ribbon.style.gap = "8px";
      ribbon.style.alignItems = "stretch";
      ribbon.style.marginBottom = "6px";
      toolbar.appendChild(ribbon);

      const makeGroup = (label) => {
        const group = document.createElement("div");
        group.style.display = "flex";
        group.style.flexDirection = "column";
        group.style.gap = "5px";
        group.style.padding = "6px";
        group.style.border = "1px solid rgba(255,255,255,0.14)";
        group.style.borderRadius = "7px";
        group.style.background = "rgba(255,255,255,0.03)";
        const titleEl = document.createElement("div");
        titleEl.textContent = label;
        titleEl.style.fontSize = "10px";
        titleEl.style.color = "rgba(229,231,235,0.75)";
        const body = document.createElement("div");
        body.style.display = "flex";
        body.style.flexWrap = "wrap";
        body.style.gap = "5px";
        body.style.alignItems = "center";
        group.appendChild(titleEl);
        group.appendChild(body);
        ribbon.appendChild(group);
        return body;
      };

      const selectionGroup = makeGroup("Selection");
      const toolsGroup = makeGroup("Tools");
      const brushGroup = makeGroup("Brushes");
      const shapesGroup = makeGroup("Shapes");
      const colorsGroup = makeGroup("Colors");
      const layersGroup = makeGroup("Layers");

      const colors = [
        "#000000", "#ffffff", "#ef4444", "#f59e0b", "#eab308", "#22c55e",
        "#06b6d4", "#3b82f6", "#6366f1", "#a855f7", "#ec4899", "#9ca3af"
      ];
      let currentColor = "#ef4444";
      let brushSize = 4;
      // Default OFF so the page stays clickable until the reviewer enables draw.
      let drawEnabled = false;
      let drawTool = "pen";
      let testingFirst = false;
      let eraserEnabled = false;
      let eraserMode = "page";
      let fillShape = false;
      let highlighterEnabled = false;
      let textToolEnabled = false;
      let textValue = "Text";
      let textSize = 20;
      let drawScope = initialDrawScope === "zone" ? "zone" : "full";
      let strokesCount = 0;
      const undoStack = [];
      const redoStack = [];
      const maxUndoStates = 20;
      let previewImageData = null;
      let startX = 0;
      let startY = 0;

      const makeButton = (label) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.style.border = "1px solid rgba(255,255,255,0.2)";
        btn.style.background = "rgba(255,255,255,0.08)";
        btn.style.color = "#f3f4f6";
        btn.style.padding = "5px 8px";
        btn.style.borderRadius = "6px";
        btn.style.fontSize = "11px";
        btn.style.cursor = "pointer";
        return btn;
      };

      colors.forEach((color) => {
        const colorBtn = document.createElement("button");
        colorBtn.type = "button";
        colorBtn.title = color;
        colorBtn.style.width = "18px";
        colorBtn.style.height = "18px";
        colorBtn.style.borderRadius = "999px";
        colorBtn.style.border = color === currentColor ? "2px solid #f9fafb" : "1px solid rgba(255,255,255,0.35)";
        colorBtn.style.background = color;
        colorBtn.style.cursor = "pointer";
        colorBtn.addEventListener("click", () => {
          currentColor = color;
          [...colorsGroup.querySelectorAll("[data-color-btn='1']")].forEach((node) => {
            node.style.border = node.getAttribute("data-color-value") === color
              ? "2px solid #f9fafb"
              : "1px solid rgba(255,255,255,0.35)";
          });
        });
        colorBtn.setAttribute("data-color-btn", "1");
        colorBtn.setAttribute("data-color-value", color);
        colorsGroup.appendChild(colorBtn);
      });

      const sizeInput = document.createElement("input");
      sizeInput.type = "range";
      sizeInput.min = "1";
      sizeInput.max = "24";
      sizeInput.value = String(brushSize);
      sizeInput.style.width = "100px";
      sizeInput.addEventListener("input", () => {
        brushSize = Number(sizeInput.value || "4");
      });
      brushGroup.appendChild(sizeInput);

      const toggleBtn = makeButton("Draw: OFF");
      canvas.style.pointerEvents = "none";
      canvas.style.cursor = "default";
      const previousOverflow = {
        html: document.documentElement.style.overflow || "",
        body: document.body.style.overflow || ""
      };
      const setScrollLocked = (locked) => {
        if (locked) {
          document.documentElement.style.overflow = "hidden";
          document.body.style.overflow = "hidden";
        } else {
          document.documentElement.style.overflow = previousOverflow.html;
          document.body.style.overflow = previousOverflow.body;
        }
      };
      const preventCanvasScroll = (event) => {
        if (!drawEnabled || testingFirst) return;
        event.preventDefault();
      };
      canvas.addEventListener("wheel", preventCanvasScroll, { passive: false });
      setScrollLocked(false);
      const applyDrawPointerState = () => {
        const capture = drawEnabled && !testingFirst;
        canvas.style.pointerEvents = capture ? "auto" : "none";
        canvas.style.cursor = capture ? "crosshair" : "default";
        setScrollLocked(capture);
        toggleBtn.textContent = drawEnabled ? "Draw: ON" : "Draw: OFF";
      };
      toggleBtn.addEventListener("click", () => {
        if (testingFirst) return;
        drawEnabled = !drawEnabled;
        applyDrawPointerState();
      });
      selectionGroup.appendChild(toggleBtn);

      const scopeGroup = document.createElement("div");
      scopeGroup.style.display = "inline-flex";
      scopeGroup.style.gap = "4px";
      const scopeFullBtn = makeButton("Full");
      const scopeZoneBtn = makeButton("Zone");
      scopeGroup.appendChild(scopeFullBtn);
      scopeGroup.appendChild(scopeZoneBtn);
      selectionGroup.appendChild(scopeGroup);

      const clearBtn = makeButton("Clear");
      toolsGroup.appendChild(clearBtn);
      const eraserBtn = makeButton("Eraser: OFF");
      toolsGroup.appendChild(eraserBtn);
      const undoBtn = makeButton("Undo");
      toolsGroup.appendChild(undoBtn);
      const redoBtn = makeButton("Redo");
      toolsGroup.appendChild(redoBtn);
      const highlighterBtn = makeButton("Highlighter: OFF");
      brushGroup.appendChild(highlighterBtn);
      const textBtn = makeButton("Text: OFF");
      toolsGroup.appendChild(textBtn);
      const eraserModeBtn = makeButton("Eraser Mode: Page");
      toolsGroup.appendChild(eraserModeBtn);
      const textInput = document.createElement("input");
      textInput.type = "text";
      textInput.placeholder = "Text tool content";
      textInput.value = textValue;
      textInput.style.width = "160px";
      textInput.style.fontSize = "11px";
      textInput.style.padding = "4px 6px";
      textInput.style.borderRadius = "5px";
      textInput.style.border = "1px solid rgba(255,255,255,0.2)";
      textInput.style.background = "rgba(255,255,255,0.08)";
      textInput.style.color = "#f3f4f6";
      textInput.addEventListener("input", () => {
        textValue = String(textInput.value || "Text");
      });
      toolsGroup.appendChild(textInput);
      const textSizeInput = document.createElement("input");
      textSizeInput.type = "range";
      textSizeInput.min = "12";
      textSizeInput.max = "48";
      textSizeInput.value = String(textSize);
      textSizeInput.style.width = "100px";
      textSizeInput.addEventListener("input", () => {
        textSize = Number(textSizeInput.value || "20");
      });
      brushGroup.appendChild(textSizeInput);
      const fillBtn = makeButton("Fill: OFF");
      shapesGroup.appendChild(fillBtn);
      const penBtn = makeButton("Pen");
      const lineBtn = makeButton("Line");
      const rectBtn = makeButton("Rect");
      const circleBtn = makeButton("Circle");
      const arrowBtn = makeButton("Arrow");
      shapesGroup.appendChild(penBtn);
      shapesGroup.appendChild(lineBtn);
      shapesGroup.appendChild(rectBtn);
      shapesGroup.appendChild(circleBtn);
      shapesGroup.appendChild(arrowBtn);
      const layerHintBtn = makeButton("Annotation Layer");
      layerHintBtn.style.opacity = "0.82";
      layerHintBtn.style.cursor = "default";
      layersGroup.appendChild(layerHintBtn);

      const noteInput = document.createElement("textarea");
      noteInput.placeholder = inputPlaceholder;
      noteInput.style.width = "100%";
      noteInput.style.minHeight = "72px";
      noteInput.style.resize = "vertical";
      noteInput.style.background = "rgba(255,255,255,0.06)";
      noteInput.style.color = "#f3f4f6";
      noteInput.style.border = "1px solid rgba(255,255,255,0.2)";
      noteInput.style.borderRadius = "8px";
      noteInput.style.padding = "8px";
      noteInput.style.fontSize = "12px";
      noteInput.style.lineHeight = "1.35";
      toolbar.appendChild(noteInput);

      const footer = document.createElement("div");
      footer.style.display = "flex";
      footer.style.justifyContent = "space-between";
      footer.style.alignItems = "center";
      footer.style.gap = "8px";
      footer.style.marginTop = "8px";
      toolbar.appendChild(footer);

      const hint = document.createElement("div");
      hint.textContent = selector
        ? (allowFullScreenEdit
          ? `Zone selector: ${selector} | Draw on full screen`
          : `Zone selector: ${selector} | Draw in zone only`)
        : "Zone selector: (none)";
      hint.style.fontSize = "10px";
      hint.style.color = "rgba(229, 231, 235, 0.72)";
      footer.appendChild(hint);

      const setScopeButtonState = () => {
        const activeBg = "rgba(59,130,246,0.35)";
        const inactiveBg = "rgba(255,255,255,0.08)";
        scopeFullBtn.style.background = drawScope === "full" ? activeBg : inactiveBg;
        scopeZoneBtn.style.background = drawScope === "zone" ? activeBg : inactiveBg;
      };
      const setShapeButtonState = () => {
        const activeBg = "rgba(59,130,246,0.35)";
        const inactiveBg = "rgba(255,255,255,0.08)";
        const states = [
          [penBtn, "pen"],
          [lineBtn, "line"],
          [rectBtn, "rect"],
          [circleBtn, "circle"],
          [arrowBtn, "arrow"]
        ];
        states.forEach(([btn, key]) => {
          btn.style.background = drawTool === key ? activeBg : inactiveBg;
        });
      };

      const updateHint = () => {
        const dragText = toolbarDragged ? " | Toolbar moved" : "";
        hint.textContent = selector
          ? `Zone selector: ${selector} | Draw ${drawScope === "full" ? "on full screen" : "in zone only"}${dragText}`
          : `Zone selector: (none)${dragText}`;
      };

      const submitBtn = makeButton(submitText);
      submitBtn.style.padding = "7px 12px";
      submitBtn.style.fontWeight = "700";
      submitBtn.style.background = "#2563eb";
      submitBtn.style.border = "1px solid #1d4ed8";
      const acceptBtn = makeButton(acceptText);
      acceptBtn.style.padding = "7px 12px";
      acceptBtn.style.fontWeight = "700";
      acceptBtn.style.background = "#059669";
      acceptBtn.style.border = "1px solid #047857";
      const testFirstBtn = makeButton("Test first");
      testFirstBtn.title = "Hide form and unlock the page so you can test, then resume feedback";
      testFirstBtn.style.padding = "7px 12px";
      testFirstBtn.style.fontWeight = "700";
      testFirstBtn.style.background = "#b45309";
      testFirstBtn.style.border = "1px solid #92400e";
      const actionButtons = document.createElement("div");
      actionButtons.style.display = "flex";
      actionButtons.style.flexWrap = "wrap";
      actionButtons.style.gap = "8px";
      actionButtons.appendChild(testFirstBtn);
      actionButtons.appendChild(acceptBtn);
      actionButtons.appendChild(submitBtn);
      footer.appendChild(actionButtons);

      const resumeDock = document.createElement("button");
      resumeDock.type = "button";
      resumeDock.id = "__browser-emulator-test-first-dock";
      resumeDock.setAttribute("aria-label", "Resume feedback");
      resumeDock.title = "Done testing — resume feedback form";
      resumeDock.style.cssText = [
        "position:fixed",
        "display:none",
        "z-index:2147483647",
        "pointer-events:auto",
        "right:16px",
        "bottom:16px",
        "min-width:48px",
        "height:48px",
        "padding:0 14px",
        "border-radius:999px",
        "border:2px solid rgba(245,158,11,.75)",
        "background:rgba(20,24,31,.96)",
        "color:#fbbf24",
        "box-shadow:0 8px 22px rgba(0,0,0,.4)",
        "font:700 12px/1 Segoe UI,sans-serif",
        "cursor:pointer",
        "align-items:center",
        "gap:8px"
      ].join(";");
      resumeDock.innerHTML = '<span style="font-size:16px;line-height:1;">↩</span><span>Resume feedback</span>';
      overlayRoot.appendChild(resumeDock);

      const setTestingFirst = (next) => {
        testingFirst = Boolean(next);
        if (testingFirst) {
          toolbar.style.display = "none";
          resumeDock.style.display = "inline-flex";
          const zoneOutline = document.getElementById("__browser-emulator-zone-outline");
          if (zoneOutline) zoneOutline.style.display = "none";
        } else {
          toolbar.style.display = "";
          resumeDock.style.display = "none";
          const zoneOutline = document.getElementById("__browser-emulator-zone-outline");
          if (zoneOutline) zoneOutline.style.display = "";
        }
        applyDrawPointerState();
      };
      testFirstBtn.addEventListener("click", () => setTestingFirst(true));
      resumeDock.addEventListener("click", () => setTestingFirst(false));

      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
      }
      let drawing = false;
      let lastX = 0;
      let lastY = 0;

      const restorePreview = () => {
        if (!ctx || !previewImageData) return;
        ctx.putImageData(previewImageData, 0, 0);
      };
      const drawShapePreview = (x2, y2) => {
        if (!ctx) return;
        restorePreview();
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = currentColor;
        ctx.fillStyle = currentColor;
        ctx.lineWidth = brushSize;
        if (drawTool === "line") {
          ctx.beginPath();
          ctx.moveTo(startX, startY);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          return;
        }
        if (drawTool === "rect") {
          const width = x2 - startX;
          const height = y2 - startY;
          if (fillShape) {
            ctx.globalAlpha = highlighterEnabled ? 0.3 : 0.22;
            ctx.fillRect(startX, startY, width, height);
            ctx.globalAlpha = 1;
          }
          ctx.strokeRect(startX, startY, width, height);
          return;
        }
        if (drawTool === "circle") {
          const radius = Math.hypot(x2 - startX, y2 - startY);
          ctx.beginPath();
          ctx.arc(startX, startY, radius, 0, Math.PI * 2);
          if (fillShape) {
            ctx.globalAlpha = highlighterEnabled ? 0.3 : 0.22;
            ctx.fill();
            ctx.globalAlpha = 1;
          }
          ctx.stroke();
          return;
        }
        if (drawTool === "arrow") {
          const headLength = Math.max(10, brushSize * 2);
          const angle = Math.atan2(y2 - startY, x2 - startX);
          ctx.beginPath();
          ctx.moveTo(startX, startY);
          ctx.lineTo(x2, y2);
          ctx.moveTo(x2, y2);
          ctx.lineTo(
            x2 - headLength * Math.cos(angle - Math.PI / 6),
            y2 - headLength * Math.sin(angle - Math.PI / 6)
          );
          ctx.moveTo(x2, y2);
          ctx.lineTo(
            x2 - headLength * Math.cos(angle + Math.PI / 6),
            y2 - headLength * Math.sin(angle + Math.PI / 6)
          );
          ctx.stroke();
        }
      };

      const drawLine = (x1, y1, x2, y2) => {
        if (!ctx) return;
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = highlighterEnabled && !eraserEnabled ? 0.38 : 1;
        if (eraserEnabled) {
          ctx.strokeStyle = eraserMode === "page" ? "#ffffff" : "rgba(20,24,31,1)";
        } else {
          ctx.strokeStyle = currentColor;
        }
        ctx.lineWidth = brushSize;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      };

      const onPointerDown = (ev) => {
        if (!drawEnabled) return;
        if (ctx) {
          try {
            undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
            redoStack.length = 0;
            if (undoStack.length > maxUndoStates) {
              undoStack.shift();
            }
          } catch {
            // ignore image snapshot errors
          }
        }
        drawing = true;
        lastX = ev.clientX;
        lastY = ev.clientY;
        startX = ev.clientX;
        startY = ev.clientY;
        if (textToolEnabled && ctx) {
          ctx.globalCompositeOperation = "source-over";
          ctx.globalAlpha = 1;
          ctx.fillStyle = currentColor;
          ctx.font = `700 ${textSize}px Segoe UI, Arial, sans-serif`;
          ctx.fillText(String(textValue || "Text"), ev.clientX, ev.clientY);
          drawing = false;
          return;
        }
        if (ctx && drawTool !== "pen") {
          try {
            previewImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          } catch {
            previewImageData = null;
          }
        }
        strokesCount += 1;
      };
      const onPointerMove = (ev) => {
        if (!drawing || !drawEnabled) return;
        if (drawScope === "zone" && zoneRect) {
          const outsideZone = ev.clientX < zoneRect.x
            || ev.clientX > (zoneRect.x + zoneRect.width)
            || ev.clientY < zoneRect.y
            || ev.clientY > (zoneRect.y + zoneRect.height);
          if (outsideZone) return;
        }
        if (drawTool === "pen") {
          drawLine(lastX, lastY, ev.clientX, ev.clientY);
        } else {
          drawShapePreview(ev.clientX, ev.clientY);
        }
        lastX = ev.clientX;
        lastY = ev.clientY;
      };
      const onPointerUp = () => {
        if (drawing && drawTool !== "pen") {
          drawShapePreview(lastX, lastY);
          previewImageData = null;
        }
        drawing = false;
      };
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointerleave", onPointerUp);

      clearBtn.addEventListener("click", () => {
        if (!ctx) return;
        try {
          undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
          redoStack.length = 0;
          if (undoStack.length > maxUndoStates) undoStack.shift();
        } catch {
          // ignore image snapshot errors
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      });
      eraserBtn.addEventListener("click", () => {
        eraserEnabled = !eraserEnabled;
        eraserBtn.textContent = eraserEnabled ? "Eraser: ON" : "Eraser: OFF";
        eraserBtn.style.background = eraserEnabled ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.08)";
        if (eraserEnabled) {
          drawTool = "pen";
          textToolEnabled = false;
          textBtn.textContent = "Text: OFF";
          textBtn.style.background = "rgba(255,255,255,0.08)";
          setShapeButtonState();
        }
      });
      eraserModeBtn.addEventListener("click", () => {
        eraserMode = eraserMode === "page" ? "annotation" : "page";
        eraserModeBtn.textContent = eraserMode === "page" ? "Eraser Mode: Page" : "Eraser Mode: Ink";
      });
      highlighterBtn.addEventListener("click", () => {
        highlighterEnabled = !highlighterEnabled;
        highlighterBtn.textContent = highlighterEnabled ? "Highlighter: ON" : "Highlighter: OFF";
        highlighterBtn.style.background = highlighterEnabled ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.08)";
      });
      undoBtn.addEventListener("click", () => {
        if (!ctx || !undoStack.length) return;
        try {
          redoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
          if (redoStack.length > maxUndoStates) redoStack.shift();
        } catch {
          // ignore image snapshot errors
        }
        const previous = undoStack.pop();
        if (!previous) return;
        ctx.putImageData(previous, 0, 0);
      });
      redoBtn.addEventListener("click", () => {
        if (!ctx || !redoStack.length) return;
        try {
          undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
          if (undoStack.length > maxUndoStates) undoStack.shift();
        } catch {
          // ignore image snapshot errors
        }
        const next = redoStack.pop();
        if (!next) return;
        ctx.putImageData(next, 0, 0);
      });
      textBtn.addEventListener("click", () => {
        textToolEnabled = !textToolEnabled;
        textBtn.textContent = textToolEnabled ? "Text: ON" : "Text: OFF";
        textBtn.style.background = textToolEnabled ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.08)";
        if (textToolEnabled) {
          eraserEnabled = false;
          eraserBtn.textContent = "Eraser: OFF";
          eraserBtn.style.background = "rgba(255,255,255,0.08)";
          drawTool = "pen";
          setShapeButtonState();
        }
      });
      fillBtn.addEventListener("click", () => {
        fillShape = !fillShape;
        fillBtn.textContent = fillShape ? "Fill: ON" : "Fill: OFF";
        fillBtn.style.background = fillShape ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.08)";
      });
      const setTool = (tool) => {
        drawTool = tool;
        eraserEnabled = false;
        textToolEnabled = false;
        eraserBtn.textContent = "Eraser: OFF";
        eraserBtn.style.background = "rgba(255,255,255,0.08)";
        textBtn.textContent = "Text: OFF";
        textBtn.style.background = "rgba(255,255,255,0.08)";
        setShapeButtonState();
      };
      penBtn.addEventListener("click", () => setTool("pen"));
      lineBtn.addEventListener("click", () => setTool("line"));
      rectBtn.addEventListener("click", () => setTool("rect"));
      circleBtn.addEventListener("click", () => setTool("circle"));
      arrowBtn.addEventListener("click", () => setTool("arrow"));

      const onResize = () => {
        const snapshot = canvas.toDataURL("image/png");
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        const image = new Image();
        image.onload = () => {
          if (ctx) ctx.drawImage(image, 0, 0);
        };
        image.src = snapshot;
      };
      window.addEventListener("resize", onResize);

      let zoneRect = null;
      if (selector) {
        const zoneEl = document.querySelector(selector);
        if (zoneEl) {
          const rect = zoneEl.getBoundingClientRect();
          zoneRect = {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
          const focusOutline = document.createElement("div");
          focusOutline.id = "__browser-emulator-zone-outline";
          focusOutline.style.position = "fixed";
          focusOutline.style.left = `${Math.round(rect.x)}px`;
          focusOutline.style.top = `${Math.round(rect.y)}px`;
          focusOutline.style.width = `${Math.max(1, Math.round(rect.width))}px`;
          focusOutline.style.height = `${Math.max(1, Math.round(rect.height))}px`;
          focusOutline.style.border = "2px dashed #f59e0b";
          focusOutline.style.background = "transparent";
          focusOutline.style.pointerEvents = "none";
          focusOutline.style.zIndex = "2147483645";
          overlayRoot.appendChild(focusOutline);
        }
      }

      if (!zoneRect) {
        drawScope = "full";
        scopeZoneBtn.disabled = true;
        scopeZoneBtn.style.opacity = "0.55";
        scopeZoneBtn.style.cursor = "not-allowed";
      } else {
        scopeZoneBtn.addEventListener("click", () => {
          drawScope = "zone";
          setScopeButtonState();
          updateHint();
        });
      }
      scopeFullBtn.addEventListener("click", () => {
        drawScope = "full";
        setScopeButtonState();
        updateHint();
      });
      setScopeButtonState();
      setShapeButtonState();
      updateHint();

      const state = {
        submitted: false,
        submission: null,
        prepareForCapture: () => {
          toolbar.style.display = "none";
          resumeDock.style.display = "none";
          const zoneOutline = document.getElementById("__browser-emulator-zone-outline");
          if (zoneOutline) zoneOutline.style.display = "none";
          canvas.style.pointerEvents = "none";
        },
        cleanup: () => {
          testingFirst = false;
          setScrollLocked(false);
          onToolbarDragEnd();
          window.removeEventListener("resize", onResize);
          canvas.removeEventListener("wheel", preventCanvasScroll);
          canvas.removeEventListener("pointerdown", onPointerDown);
          canvas.removeEventListener("pointermove", onPointerMove);
          canvas.removeEventListener("pointerup", onPointerUp);
          canvas.removeEventListener("pointerleave", onPointerUp);
          if (overlayRoot.parentElement) overlayRoot.parentElement.removeChild(overlayRoot);
          delete window.__browserEmulatorHold;
        }
      };

      submitBtn.addEventListener("click", () => {
        const noteText = String(noteInput.value || "").trim();
        if (noteRequired && !noteText) {
          noteInput.focus();
          noteInput.style.borderColor = "#ef4444";
          return;
        }
        state.submitted = true;
        state.submission = {
          decision: "feedback",
          noteText,
          noteLength: noteText.length,
          selector: selector || "",
          zoneRect,
          strokesCount,
          submittedAt: new Date().toISOString(),
          annotationDataUrl: canvas.toDataURL("image/png")
        };
      });

      acceptBtn.addEventListener("click", () => {
        const raw = String(noteInput.value || "").trim();
        const noteText = raw || "ACCEPTED";
        state.submitted = true;
        state.submission = {
          decision: "accept",
          noteText,
          noteLength: noteText.length,
          selector: selector || "",
          zoneRect,
          strokesCount,
          submittedAt: new Date().toISOString(),
          annotationDataUrl: canvas.toDataURL("image/png")
        };
      });

      document.body.appendChild(overlayRoot);
      window.__browserEmulatorHold = state;
    },
    {
      zoneSelector,
      promptText: prompt,
      toolbarTitleText: toolbarTitle,
      submitText: submitLabel,
      acceptText: acceptLabel,
      inputPlaceholder: placeholder,
      noteRequired: requireNote,
      allowFullScreenEdit: fullScreenEdit,
      initialDrawScope
    }
  );

  try {
    await page.waitForFunction(
      () => Boolean(window.__browserEmulatorHold && window.__browserEmulatorHold.submitted),
      null,
      { timeout: holdTimeoutMs > 0 ? holdTimeoutMs : 0 }
    );
  } catch (error) {
    const message = String((error && error.message) || error || "");
    if (!message.toLowerCase().includes("timeout")) {
      throw error;
    }
    await page.evaluate(() => {
      const hold = window.__browserEmulatorHold;
      if (!hold || hold.submitted) return;
      hold.submitted = true;
      hold.submission = {
        decision: "timeout",
        noteText: "HOLD_TIMEOUT",
        noteLength: 12,
        selector: "",
        zoneRect: null,
        strokesCount: 0,
        submittedAt: new Date().toISOString(),
        annotationDataUrl: null
      };
    });
  }

  const submission = await page.evaluate(() => {
    const hold = window.__browserEmulatorHold;
    if (!hold || !hold.submitted) return null;
    // Keep toolbar visible on timeout so artifacts show hold UI.
    const shouldHideUiForCapture = hold.submission && hold.submission.decision !== "timeout";
    if (shouldHideUiForCapture && typeof hold.prepareForCapture === "function") {
      hold.prepareForCapture();
    }
    return hold.submission || null;
  });

  if (!submission) {
    throw new Error("holdForUserAnswer finished without a submission payload.");
  }

  return {
    kind: "holdForUserAnswer",
    summary: `hold answer submitted: ${submission.decision || "feedback"} (${submission.noteLength || 0} chars)`,
    data: {
      ...submission,
      zoneFound: Boolean(zoneResult && zoneResult.zoneFound),
      zoneRectFromStart: zoneResult ? zoneResult.zoneRect : null
    }
  };
}

async function applyAction(page, action, timeoutMs) {
  if (!action || !action.type) {
    throw new Error("Invalid action object: missing type");
  }

  switch (action.type) {
    case "click":
      if (!action.selector) throw new Error("click requires selector");
      {
        const beforeDom = String(action.expectDomChange || "").trim().toLowerCase() === "true"
          ? await page.content()
          : "";
        const clickable = await findClickableLocator(page, action.selector, timeoutMs);
        try {
          await runWithNavigationRetry(page, () => clickable.click({ timeout: timeoutMs }));
        } catch (error) {
          const isTextSelector = String(action.selector || "").startsWith("text=");
          if (isTextSelector) {
            const targetText = String(action.selector || "").slice(5).trim();
            const clickedByText = await clickByLooseTextFallback(page, targetText).catch(() => false);
            if (clickedByText) {
              return `clicked ${action.selector}`;
            }
          }
          const hasTextValue = extractHasTextValue(action.selector);
          if (hasTextValue) {
            const clickedByHasText = await clickByLooseTextFallback(page, hasTextValue).catch(() => false);
            if (clickedByHasText) {
              return `clicked ${action.selector}`;
            }
          }
          if (isOverlayInterceptionError(error)) {
            const dismissed = await dismissOverlayScrim(page, timeoutMs);
            if (!dismissed) throw error;
            await runWithNavigationRetry(page, () => clickable.click({ timeout: timeoutMs }));
          } else if (String((error && error.message) || error || "").includes("intercepts pointer events")) {
            await runWithNavigationRetry(page, () =>
              clickable.click({ timeout: timeoutMs, force: true })
            );
          } else {
            throw error;
          }
        }
        await verifyActionExpectations(page, action, timeoutMs, beforeDom);
      }
      return `clicked ${action.selector}`;

    case "fill":
      if (!action.selector) throw new Error("fill requires selector");
      {
        const beforeDom = String(action.expectDomChange || "").trim().toLowerCase() === "true"
          ? await page.content()
          : "";
        const fillTarget = await findVisibleLocator(page, action.selector, timeoutMs);
        await runWithNavigationRetry(page, () => fillTarget.fill(String(action.value || ""), {
          timeout: timeoutMs
        }));
        await verifyActionExpectations(page, action, timeoutMs, beforeDom);
      }
      return `filled ${action.selector}`;

    case "press":
      if (!action.key) throw new Error("press requires key");
      await page.keyboard.press(action.key);
      return `pressed ${action.key}`;

    case "waitForSelector":
      if (!action.selector) throw new Error("waitForSelector requires selector");
      {
        const waitTarget = await findVisibleLocator(page, action.selector, timeoutMs);
        await waitTarget.waitFor({ state: "visible", timeout: timeoutMs });
      }
      return `waited for ${action.selector}`;

    case "waitForTimeout":
      await page.waitForTimeout(Number(action.ms || 500));
      return `waited ${Number(action.ms || 500)}ms`;

    case "setViewport": {
      const width = Number(action.width);
      const height = Number(action.height);
      if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
        throw new Error("setViewport requires --width and --height");
      }
      await page.setViewportSize({
        width: Math.round(width),
        height: Math.round(height)
      });
      return `set viewport ${Math.round(width)}x${Math.round(height)}`;
    }

    case "goto":
      if (!action.url) throw new Error("goto requires url");
      {
        const beforeDom = String(action.expectDomChange || "").trim().toLowerCase() === "true"
          ? await page.content()
          : "";
        try {
          await page.goto(action.url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
        } catch (error) {
          const message = String((error && error.message) || error || "");
          const currentUrl = page.url() || "";
          let currentHost = "";
          let targetHost = "";
          let currentPath = "";
          let targetPath = "";
          try {
            currentHost = new URL(currentUrl).hostname.toLowerCase();
            targetHost = new URL(String(action.url)).hostname.toLowerCase();
            currentPath = new URL(currentUrl).pathname.replace(/\/$/, "");
            targetPath = new URL(String(action.url)).pathname.replace(/\/$/, "");
          } catch {
            // keep empty
          }
          const onTarget =
            message.toLowerCase().includes("timeout") &&
            currentHost &&
            targetHost &&
            currentHost === targetHost &&
            currentPath === targetPath;
          if (!onTarget) throw error;
        }
        await verifyActionExpectations(page, action, timeoutMs, beforeDom);
      }
      return `navigated ${action.url}`;

    case "evaluate":
      if (!action.script) throw new Error("evaluate requires script");
      {
        const beforeDom = String(action.expectDomChange || "").trim().toLowerCase() === "true"
          ? await page.content()
          : "";
        const evaluated = await page.evaluate(code => {
          // eslint-disable-next-line no-eval
          return window.eval(code);
        }, String(action.script));
        await verifyActionExpectations(page, action, timeoutMs, beforeDom);
        if (evaluated === undefined) return "evaluated page script";
        if (typeof evaluated === "string") return evaluated;
        try {
          return JSON.stringify(evaluated);
        } catch {
          return String(evaluated);
        }
      }

    case "hold":
    case "holdForUserAnswer":
      return runHoldForUserAnswer(page, action, timeoutMs);

    default:
      throw new Error(`Unsupported action type: ${action.type}`);
  }
}

async function captureDom(page, outputPath, writeTextFileFn) {
  const html = await page.content();
  writeTextFileFn(outputPath, html);
  return html.length;
}

module.exports = {
  applyAction,
  captureDom
};

