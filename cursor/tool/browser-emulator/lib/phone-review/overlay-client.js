(function () {
  if (window.__emuHoldStarted || window.__emuPhoneHoldStarted) return;
  window.__emuHoldStarted = true;
  window.__emuPhoneHoldStarted = true;
  window.__emuOverlaySwap = false;

  var existing =
    document.getElementById("__emu-hold-root") ||
    document.getElementById("emu-phone-hold-root") ||
    document.getElementById("phone-preview-hold-root");
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  var overlay = document.createElement("div");
  overlay.id = "__emu-hold-root";
  overlay.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";

  var liveStyle = document.createElement("style");
  liveStyle.textContent = "@keyframes emuPhoneLivePulse{0%,100%{opacity:.45;transform:scale(.9)}50%{opacity:1;transform:scale(1.15)}}";
  overlay.appendChild(liveStyle);

  var live = document.createElement("div");
  live.style.cssText = "position:fixed;top:calc(8px + env(safe-area-inset-top));right:8px;z-index:2147483647;display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;background:rgba(20,24,31,.94);border:1px solid rgba(217,238,11,.5);color:#f4f4f7;font:700 11px/1 Segoe UI,sans-serif;letter-spacing:.04em;";
  live.innerHTML = '<span id="emu-phone-live-dot" style="width:8px;height:8px;border-radius:50%;background:#d9ee0b;box-shadow:0 0 8px rgba(217,238,11,.85);animation:emuPhoneLivePulse 1.4s ease-in-out infinite;"></span><span id="emu-phone-live-label">WAIT</span>';
  overlay.appendChild(live);

  var canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;touch-action:none;";
  overlay.appendChild(canvas);

  var toolbar = document.createElement("div");
  var defaultWidth = Math.min(320, Math.max(220, window.innerWidth - 16));
  var defaultTop = 44;
  var defaultLeft = Math.max(8, window.innerWidth - defaultWidth - 8);
  toolbar.style.cssText = "position:fixed;left:" + defaultLeft + "px;top:" + defaultTop + "px;width:" + defaultWidth + "px;min-width:220px;min-height:140px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);pointer-events:auto;background:rgba(20,24,31,.97);color:#e5e7eb;border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:8px;padding-bottom:18px;font:12px/1.35 Segoe UI,sans-serif;z-index:2147483647;display:flex;flex-direction:column;box-shadow:0 10px 28px rgba(0,0,0,.38);box-sizing:border-box;";
  toolbar.innerHTML = ""
    + '<div id="emu-phone-drag" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;cursor:move;user-select:none;touch-action:none;">'
    + '<div style="font-weight:700;">Hands-free review</div>'
    + '<div style="font-size:10px;opacity:.68;">Drag</div>'
    + "</div>"
    + '<div style="opacity:.85;margin-bottom:6px;">Type a note, then Submit / Accept.</div>'
    + '<textarea id="emu-phone-note" placeholder="Type feedback..." style="width:100%;flex:1;min-height:40px;box-sizing:border-box;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#f3f4f6;padding:8px;resize:none;"></textarea>'
    + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">'
    + '<button type="button" id="emu-phone-draw">Draw: OFF</button>'
    + '<button type="button" id="emu-phone-clear">Clear</button>'
    + '<button type="button" id="emu-phone-submit">Submit screen</button>'
    + '<button type="button" id="emu-phone-accept">Accept</button>'
    + "</div>"
    + '<div id="emu-phone-status" style="margin-top:6px;font-size:11px;opacity:.8;"></div>'
    + '<div id="emu-phone-resize" style="position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:nwse-resize;touch-action:none;background:linear-gradient(135deg,transparent 0 50%,rgba(255,255,255,.45) 50% 55%,transparent 55% 70%,rgba(255,255,255,.45) 70% 75%,transparent 75%);"></div>';
  overlay.appendChild(toolbar);

  var dock = document.createElement("button");
  dock.id = "emu-phone-dock";
  dock.type = "button";
  dock.setAttribute("aria-label", "Open review");
  dock.style.cssText = "position:fixed;display:none;z-index:2147483647;pointer-events:auto;width:48px;height:48px;padding:0;border-radius:999px;border:2px solid rgba(217,238,11,.7);background:rgba(20,24,31,.96);color:#d9ee0b;box-shadow:0 8px 22px rgba(0,0,0,.4);touch-action:none;cursor:grab;";
  dock.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  overlay.appendChild(dock);
  document.body.appendChild(overlay);

  var box1 = document.createElement("div");
  box1.id = "emu-phone-box1";
  box1.setAttribute("data-emu-box1", "1");
  box1.style.cssText = "position:fixed;z-index:2147483645;display:none;pointer-events:auto;-webkit-overflow-scrolling:touch;overflow:auto;padding:14px 16px;border-radius:16px;background:rgba(10,10,14,.94);border:1px solid rgba(255,255,255,.16);color:#f4f4f7;font:600 16px/1.45 Segoe UI,sans-serif;letter-spacing:.01em;box-sizing:border-box;white-space:pre-wrap;word-break:break-word;";
  overlay.appendChild(box1);

  function persistBox1(text) {
    try { window.sessionStorage.setItem("__emu_box1_answer", String(text || "")); } catch (err) {}
  }
  function readPersistedBox1() {
    try { return String(window.sessionStorage.getItem("__emu_box1_answer") || ""); } catch (err) { return ""; }
  }
  function clearProductAnswer() {
    var nodes = document.querySelectorAll("[data-emu-answer]");
    for (var i = 0; i < nodes.length; i += 1) nodes[i].textContent = "";
  }
  function showBox1(text) {
    var next = String(text || "").trim();
    persistBox1(next);
    clearProductAnswer();
    box1.style.display = "none";
    var status = toolbar.querySelector("#emu-phone-status");
    if (status) status.textContent = next;
  }
  function hideBox1() {
    box1.style.display = "none";
  }
  try { window.sessionStorage.removeItem("__emu_box1_answer"); } catch (err) {}
  showBox1("");

  Array.prototype.forEach.call(toolbar.querySelectorAll("button"), function (btn) {
    btn.style.cssText += "border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#f3f4f6;padding:8px 10px;border-radius:8px;font-size:12px;";
  });
  toolbar.querySelector("#emu-phone-submit").style.background = "#2563eb";
  toolbar.querySelector("#emu-phone-accept").style.background = "#16a34a";

  (function enableMoveResize() {
    var storeKey = "__emu-hold-form-v3";
    var minW = 220;
    var minH = 140;
    var pad = 8;
    var dockSize = 48;
    var edgeSnap = 18;
    var docked = false;
    var lastDock = { left: 0, top: 0 };
    var holdBusy = false;
    function clampBox(left, top, width, height) {
      var maxW = Math.max(minW, window.innerWidth - pad * 2);
      var maxH = Math.max(minH, window.innerHeight - pad * 2);
      var w = Math.min(Math.max(minW, width), maxW);
      var h = Math.min(Math.max(minH, height), maxH);
      var l = Math.min(Math.max(pad, left), Math.max(pad, window.innerWidth - w - pad));
      var t = Math.min(Math.max(pad, top), Math.max(pad, window.innerHeight - h - pad));
      return { left: l, top: t, width: w, height: h };
    }
    function applyBox(box) {
      lastForm = box;
      toolbar.style.left = Math.round(box.left) + "px";
      toolbar.style.top = Math.round(box.top) + "px";
      toolbar.style.width = Math.round(box.width) + "px";
      toolbar.style.height = Math.round(box.height) + "px";
      toolbar.style.right = "auto";
      toolbar.style.bottom = "auto";
    }
    function currentBox() {
      if (docked && lastForm) return lastForm;
      var r = toolbar.getBoundingClientRect();
      if (r.width < 8 && lastForm) return lastForm;
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }
    function nearestEdge(box) {
      var dL = box.left;
      var dT = box.top;
      var dR = window.innerWidth - (box.left + box.width);
      var dB = window.innerHeight - (box.top + box.height);
      var edge = "right";
      var dist = dR;
      if (dL <= dist) { edge = "left"; dist = dL; }
      if (dT <= dist) { edge = "top"; dist = dT; }
      if (dB <= dist) { edge = "bottom"; dist = dB; }
      return { edge: edge, dist: dist };
    }
    function clampToBorder(left, top) {
      var maxX = Math.max(dockPad(), window.innerWidth - dockSize - dockPad());
      var maxY = Math.max(dockPad(), window.innerHeight - dockSize - dockPad());
      var x = Math.min(Math.max(dockPad(), left), maxX);
      var y = Math.min(Math.max(dockPad(), top), maxY);
      var dL = x - dockPad();
      var dR = maxX - x;
      var dT = y - dockPad();
      var dB = maxY - y;
      var edge = "right";
      var min = dR;
      if (dL <= min) { min = dL; edge = "left"; }
      if (dT <= min) { min = dT; edge = "top"; }
      if (dB <= min) { min = dB; edge = "bottom"; }
      if (edge === "left") x = dockPad();
      if (edge === "right") x = maxX;
      if (edge === "top") y = dockPad();
      if (edge === "bottom") y = maxY;
      var badge = live.getBoundingClientRect();
      if (badge.width > 4) {
        var hitX = x < badge.right + 8 && x + dockSize > badge.left - 8;
        var hitY = y < badge.bottom + 8 && y + dockSize > badge.top - 8;
        if (hitX && hitY) {
          y = Math.round(badge.bottom + 8);
          if (edge === "top") edge = "right";
          x = Math.max(dockPad(), window.innerWidth - dockSize - dockPad());
        }
      }
      return { left: x, top: y, edge: edge };
    }
    function dockPad() { return pad; }
    function applyDock(pos) {
      lastDock = pos;
      dock.style.left = Math.round(pos.left) + "px";
      dock.style.top = Math.round(pos.top) + "px";
      dock.style.right = "auto";
      dock.style.bottom = "auto";
    }
    function dockFromBox(box) {
      var near = nearestEdge(box);
      var cx = box.left + box.width / 2 - dockSize / 2;
      var cy = box.top + box.height / 2 - dockSize / 2;
      if (near.edge === "left") cx = pad;
      if (near.edge === "right") cx = window.innerWidth - dockSize - pad;
      if (near.edge === "top") cy = pad;
      if (near.edge === "bottom") cy = window.innerHeight - dockSize - pad;
      return clampToBorder(cx, cy);
    }
    function setDocked(next, pos) {
      docked = Boolean(next);
      if (docked) {
        applyDock(pos || clampToBorder(window.innerWidth - dockSize - pad, 52));
        toolbar.style.display = "none";
        dock.style.display = holdBusy ? "none" : "";
      } else {
        dock.style.display = "none";
        toolbar.style.display = holdBusy ? "none" : "";
      }
    }
    function saveBox() {
      var box = currentBox();
      var icon = dock.getBoundingClientRect();
      var payload = {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        docked: docked,
        iconLeft: docked ? icon.left : 0,
        iconTop: docked ? icon.top : 0
      };
      try { window.localStorage.setItem(storeKey, JSON.stringify(payload)); } catch (err) {}
    }
    function readSaved() {
      var keys = [storeKey, "__emu-hold-form-v2"];
      for (var i = 0; i < keys.length; i += 1) {
        try {
          var saved = JSON.parse(window.localStorage.getItem(keys[i]) || "null");
          if (saved && typeof saved.left === "number") return saved;
        } catch (err) {}
      }
      return null;
    }
    function restoreBox() {
      var saved = readSaved();
      if (!saved) return;
      applyBox(clampBox(saved.left, saved.top, saved.width, saved.height));
      if (saved.docked) setDocked(true, clampToBorder(saved.iconLeft || saved.left, saved.iconTop || saved.top));
    }
    function undock() {
      var icon = dock.getBoundingClientRect();
      var box = lastForm || currentBox();
      setDocked(false);
      var left = icon.left + icon.width / 2 - box.width / 2;
      var top = icon.top - 12;
      var next = clampBox(left, top, box.width, box.height);
      var near = nearestEdge(next);
      if (near.dist <= edgeSnap + 8) {
        var inset = 56;
        if (near.edge === "left") next.left = inset;
        if (near.edge === "right") next.left = window.innerWidth - next.width - inset;
        if (near.edge === "top") next.top = inset;
        if (near.edge === "bottom") next.top = window.innerHeight - next.height - inset;
        next = clampBox(next.left, next.top, next.width, next.height);
      }
      applyBox(next);
      saveBox();
    }
    function maybeDock() {
      var box = currentBox();
      var near = nearestEdge(box);
      if (near.dist > edgeSnap) return;
      lastForm = box;
      setDocked(true, dockFromBox(box));
    }
    restoreBox();
    window.__emuHoldSetBusy = function (busy) {
      holdBusy = Boolean(busy);
      if (holdBusy) {
        toolbar.style.display = "none";
        dock.style.display = "none";
        return;
      }
      var pos = lastDock.left || lastDock.top
        ? lastDock
        : clampToBorder(dock.getBoundingClientRect().left, dock.getBoundingClientRect().top);
      setDocked(docked, pos);
    };
    function bindDrag(el, onMove, onUp) {
      el.addEventListener("pointerdown", function (event) {
        if (event.button != null && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        var start = currentBox();
        if (el === dock) start = dock.getBoundingClientRect();
        var origin = { x: event.clientX, y: event.clientY };
        var moved = 0;
        function move(ev) {
          var dx = ev.clientX - origin.x;
          var dy = ev.clientY - origin.y;
          moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
          onMove(start, dx, dy);
        }
        function up() {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          if (onUp) onUp(moved);
          else saveBox();
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        try { el.setPointerCapture(event.pointerId); } catch (err) {}
      });
    }
    bindDrag(toolbar.querySelector("#emu-phone-drag"), function (start, dx, dy) {
      applyBox(clampBox(start.left + dx, start.top + dy, start.width, start.height));
    }, function () {
      maybeDock();
      saveBox();
    });
    bindDrag(toolbar.querySelector("#emu-phone-resize"), function (start, dx, dy) {
      applyBox(clampBox(start.left, start.top, start.width + dx, start.height + dy));
    });
    bindDrag(dock, function (start, dx, dy) {
      applyDock(clampToBorder(start.left + dx, start.top + dy));
    }, function (moved) {
      if (moved < 10) undock();
      else saveBox();
    });
    window.addEventListener("resize", function () {
      if (docked) applyDock(clampToBorder(dock.getBoundingClientRect().left, dock.getBoundingClientRect().top));
      else applyBox(clampBox(currentBox().left, currentBox().top, currentBox().width, currentBox().height));
    });
  })();

  var ctx = canvas.getContext("2d");
  var drawing = false;
  var drawOn = false;
  var strokes = 0;
  var last = null;

  function sizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  sizeCanvas();
  window.addEventListener("resize", sizeCanvas);

  function point(event) {
    var t = event.touches && event.touches[0] ? event.touches[0] : event;
    return { x: t.clientX, y: t.clientY };
  }
  function startDraw(event) {
    if (!drawOn) return;
    drawing = true;
    last = point(event);
    event.preventDefault();
  }
  function moveDraw(event) {
    if (!drawing || !drawOn) return;
    var now = point(event);
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(now.x, now.y);
    ctx.stroke();
    last = now;
    strokes += 1;
    event.preventDefault();
  }
  function endDraw() {
    drawing = false;
    last = null;
  }

  canvas.addEventListener("pointerdown", startDraw);
  canvas.addEventListener("pointermove", moveDraw);
  canvas.addEventListener("pointerup", endDraw);
  canvas.addEventListener("pointercancel", endDraw);
  canvas.addEventListener("touchstart", startDraw, { passive: false });
  canvas.addEventListener("touchmove", moveDraw, { passive: false });
  canvas.addEventListener("touchend", endDraw);

  var drawBtn = toolbar.querySelector("#emu-phone-draw");
  drawBtn.addEventListener("click", function () {
    drawOn = !drawOn;
    drawBtn.textContent = drawOn ? "Draw: ON" : "Draw: OFF";
    canvas.style.pointerEvents = drawOn ? "auto" : "none";
  });
  toolbar.querySelector("#emu-phone-clear").addEventListener("click", function () {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokes = 0;
  });

  function loadHtml2Canvas() {
    return new Promise(function (resolve, reject) {
      if (window.html2canvas) {
        resolve(window.html2canvas);
        return;
      }
      var script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
      script.onload = function () { resolve(window.html2canvas); };
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  function capturePage() {
    overlay.style.visibility = "hidden";
    return loadHtml2Canvas()
      .then(function (html2canvas) {
        return html2canvas(document.body, {
          useCORS: true,
          allowTaint: true,
          logging: false,
          backgroundColor: "#0b0f19",
          scale: Math.min(1, 960 / Math.max(window.innerWidth, 1)),
          windowWidth: window.innerWidth,
          windowHeight: window.innerHeight
        });
      })
      .then(function (shot) {
        overlay.style.visibility = "visible";
        return shot.toDataURL("image/jpeg", 0.82);
      })
      .catch(function () {
        overlay.style.visibility = "visible";
        return "";
      });
  }

  function send(decision) {
    var status = toolbar.querySelector("#emu-phone-status");
    status.textContent = "Capturing screen...";
    function holdToken() {
      try {
        var q = new URLSearchParams(location.search || "").get("emu_hold");
        if (q) return String(q);
      } catch (e) {}
      try {
        var m = String(document.cookie || "").match(/(?:^|; )emu_hold=([^;]*)/);
        if (m) return decodeURIComponent(m[1]);
      } catch (e2) {}
      return "";
    }
    capturePage().then(function (screenshotDataUrl) {
      status.textContent = "Sending...";
      var token = holdToken();
      return fetch("/__emu/hold", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-emu-hold-token": token
        },
        body: JSON.stringify({
          decision: decision,
          holdToken: token,
          noteText: toolbar.querySelector("#emu-phone-note").value || "",
          strokesCount: strokes,
          screenshotDataUrl: screenshotDataUrl,
          annotationDataUrl: strokes ? canvas.toDataURL("image/png") : ""
        })
      });
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (body) {
      var started = Boolean(body && (body.ideStarted || body.waiting || body.state === "progress"));
      if (typeof window.__emuSetLiveState === "function") {
        window.__emuSetLiveState(started ? "progress" : "live");
      }
      if (started) {
        status.textContent = decision === "accept"
          ? "Accepted. Agent started."
          : "Sent. Agent started.";
      } else {
        status.textContent = "Sent. Agent is not in listen.";
      }
    }).catch(function (err) {
      status.textContent = "Send failed: " + err.message;
      if (typeof window.__emuSetLiveState === "function") window.__emuSetLiveState("live");
    });
  }

  toolbar.querySelector("#emu-phone-submit").addEventListener("click", function () { send("feedback"); });
  toolbar.querySelector("#emu-phone-accept").addEventListener("click", function () { send("accept"); });

  (function watchLiveReload() {
    var current = null;
    var lastState = "";
    var timer = null;
    var inflight = null;
    var socket = null;
    var usingSocket = false;
    var stopped = false;
    var loadedRev = "";
    var dot = document.getElementById("emu-phone-live-dot");
    var label = document.getElementById("emu-phone-live-label");
    var liveCfg = window.__EMU_LIVE__ || {};
    loadedRev = String(liveCfg.overlayRev || "");

    function setAgentUi(mode) {
      var busy = mode === "progress";
      var on = mode === "live" || busy;
      if (typeof window.__emuHoldSetBusy === "function") window.__emuHoldSetBusy(busy);
      else toolbar.style.display = busy ? "none" : "";
      canvas.style.display = busy ? "none" : "";
      live.style.borderColor = busy
        ? "rgba(244,114,182,.7)"
        : (on ? "rgba(217,238,11,.5)" : "rgba(148,163,184,.4)");
      if (dot) {
        dot.style.background = busy ? "#f472b6" : (on ? "#d9ee0b" : "#94a3b8");
        dot.style.boxShadow = busy
          ? "0 0 8px rgba(244,114,182,.85)"
          : (on ? "0 0 8px rgba(217,238,11,.85)" : "none");
        dot.style.animation = on ? "emuPhoneLivePulse 1.4s ease-in-out infinite" : "none";
      }
      if (label) label.textContent = busy ? "IN PROGRESS" : (on ? "WAIT" : "OFF");
      if (busy) hideBox1();
      else showBox1(readPersistedBox1());
    }
    window.__emuSetLiveState = function (mode) {
      lastState = mode === "progress" ? "progress" : "listening";
      setAgentUi(mode === "progress" ? "progress" : "live");
    };

    function maybeSwapOverlay(rev, allowSwap) {
      if (stopped || !rev || !allowSwap) return;
      var nextRev = String(rev);
      if (!nextRev || nextRev === loadedRev) return;
      loadedRev = nextRev;
      if (window.__emuOverlaySwap) return;
      window.__emuOverlaySwap = true;
      stopped = true;
      if (socket) {
        try { socket.close(); } catch (err) {}
      }
      window.__emuHoldStarted = false;
      window.__emuPhoneHoldStarted = false;
      var script = document.createElement("script");
      script.src = "/__emu/hold.js?rev=" + encodeURIComponent(nextRev);
      document.documentElement.appendChild(script);
    }

    function applyPayload(data, allowReload) {
      if (!data) return;
      if (data.answer) persistBox1(data.answer);
      if (data.overlayRev) maybeSwapOverlay(data.overlayRev, data.swapOverlay === true);
      if (data.state === "progress") {
        lastState = "progress";
        setAgentUi("progress");
      } else if (data.state === "listening") {
        if (!(lastState === "progress" && data.v == null)) {
          lastState = "listening";
          setAgentUi("live");
        }
      }
      if (data.v == null) return;
      var next = String(data.v);
      var prev = current;
      current = next;
      var liveOn = usingSocket || liveCfg.enabled;
      if (allowReload && !liveOn && prev !== null && next !== prev) {
        window.location.reload();
      }
    }

    function schedule(ms) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, ms);
    }

    function tick() {
      if (stopped || usingSocket || document.hidden) {
        if (inflight && inflight.abort) inflight.abort();
        inflight = null;
        return;
      }
      var query = "/__emu/version?wait=1&waitMs=20000";
      if (current != null) {
        query += "&since=" + encodeURIComponent(current) + "&sinceState=" + encodeURIComponent(lastState);
      }
      var ctrl = typeof AbortController === "function" ? new AbortController() : null;
      inflight = ctrl;
      fetch(query, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: ctrl ? ctrl.signal : undefined
      })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          if (!data || data.v == null) {
            setAgentUi("off");
            return;
          }
          applyPayload(data, true);
        })
        .catch(function (err) {
          if (err && err.name === "AbortError") return;
          setAgentUi("off");
        })
        .finally(function () {
          inflight = null;
          if (stopped) return;
          if (!document.hidden && !usingSocket) schedule(250);
        });
    }

    function startSocket() {
      if (stopped || usingSocket || !liveCfg.enabled || !liveCfg.path || typeof WebSocket === "undefined") return false;
      var proto = location.protocol === "https:" ? "wss:" : "ws:";
      var ws;
      try {
        ws = new WebSocket(proto + "//" + location.host + liveCfg.path);
      } catch (err) {
        return false;
      }
      socket = ws;
      ws.onopen = function () {
        if (stopped) return;
        usingSocket = true;
        if (inflight && inflight.abort) inflight.abort();
      };
      ws.onmessage = function (event) {
        if (stopped) return;
        var msg;
        try {
          msg = JSON.parse(event.data);
        } catch (err) {
          return;
        }
        var payload = msg && msg.payload ? msg.payload : msg;
        if (msg && (msg.name === "live.state" || msg.name === "live.reload" || msg.name === "hold.submitted" || msg.name === "ide.task")) {
          if (msg.name === "ide.task") {
            var phase = payload && payload.phase ? String(payload.phase) : "";
            if (phase === "work") {
              lastState = "progress";
              setAgentUi("progress");
            } else {
              if (payload && payload.content) persistBox1(payload.content);
              lastState = "listening";
              setAgentUi("live");
            }
            return;
          }
          if (msg.name === "hold.submitted") {
            if (payload && (payload.state === "progress" || payload.ideStarted)) {
              lastState = "progress";
              setAgentUi("progress");
            } else {
              lastState = "listening";
              setAgentUi("live");
            }
            return;
          }
          applyPayload(payload, false);
        }
      };
      ws.onclose = function () {
        if (stopped) return;
        usingSocket = false;
        socket = null;
        scheduleReconnect();
      };
      ws.onerror = function () {
        try { ws.close(); } catch (err) {}
      };
      return true;
    }

    function scheduleReconnect() {
      if (stopped || usingSocket) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        if (stopped || usingSocket) return;
        if (!startSocket()) {
          if (!liveCfg.enabled) schedule(400);
          else scheduleReconnect();
        }
      }, 800);
    }

    document.addEventListener("visibilitychange", function () {
      if (stopped) return;
      if (!document.hidden) {
        if (liveCfg.enabled) {
          if (!usingSocket) startSocket();
          return;
        }
        if (timer) clearTimeout(timer);
        tick();
      } else if (inflight && inflight.abort) {
        inflight.abort();
      }
    });
    if (!startSocket()) {
      if (liveCfg.enabled) scheduleReconnect();
      else tick();
    }
  })();
})();
