(function () {
  if (window.__emuHoldStarted || window.__emuPhoneHoldStarted) return;
  window.__emuHoldStarted = true;
  window.__emuPhoneHoldStarted = true;

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

  var toolbarBottom = window.innerWidth < 960 ? "78px" : "16px";
  var toolbar = document.createElement("div");
  toolbar.style.cssText = "position:fixed;left:8px;right:8px;bottom:" + toolbarBottom + ";pointer-events:auto;background:rgba(20,24,31,.97);color:#e5e7eb;border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:8px;font:12px/1.35 Segoe UI,sans-serif;z-index:2147483647;max-height:38vh;overflow:auto;";
  toolbar.innerHTML = ""
    + '<div style="font-weight:700;margin-bottom:4px;">Hands-free review</div>'
    + '<div style="opacity:.85;margin-bottom:6px;">Type a note, then Submit / Accept.</div>'
    + '<textarea id="emu-phone-note" placeholder="Type feedback..." style="width:100%;min-height:40px;box-sizing:border-box;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#f3f4f6;padding:8px;"></textarea>'
    + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">'
    + '<button type="button" id="emu-phone-draw">Draw: OFF</button>'
    + '<button type="button" id="emu-phone-clear">Clear</button>'
    + '<button type="button" id="emu-phone-submit">Submit screen</button>'
    + '<button type="button" id="emu-phone-accept">Accept</button>'
    + "</div>"
    + '<div id="emu-phone-status" style="margin-top:6px;font-size:11px;opacity:.8;"></div>';
  overlay.appendChild(toolbar);
  document.body.appendChild(overlay);

  Array.prototype.forEach.call(toolbar.querySelectorAll("button"), function (btn) {
    btn.style.cssText += "border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#f3f4f6;padding:8px 10px;border-radius:8px;font-size:12px;";
  });
  toolbar.querySelector("#emu-phone-submit").style.background = "#2563eb";
  toolbar.querySelector("#emu-phone-accept").style.background = "#16a34a";

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
          scale: Math.min(1, 480 / Math.max(window.innerWidth, 1)),
          windowWidth: window.innerWidth,
          windowHeight: window.innerHeight
        });
      })
      .then(function (shot) {
        overlay.style.visibility = "visible";
        return shot.toDataURL("image/jpeg", 0.7);
      })
      .catch(function () {
        overlay.style.visibility = "visible";
        return "";
      });
  }

  function send(decision) {
    var status = toolbar.querySelector("#emu-phone-status");
    status.textContent = "Capturing screen...";
    capturePage().then(function (screenshotDataUrl) {
      status.textContent = "Sending...";
      return fetch("/__emu/hold", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          decision: decision,
          noteText: toolbar.querySelector("#emu-phone-note").value || "",
          strokesCount: strokes,
          screenshotDataUrl: screenshotDataUrl,
          annotationDataUrl: strokes ? canvas.toDataURL("image/png") : ""
        })
      });
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function () {
      status.textContent = decision === "accept"
        ? "Accepted. Screen sent."
        : "Sent with screen snapshot.";
    }).catch(function (err) {
      status.textContent = "Send failed: " + err.message;
    });
  }

  toolbar.querySelector("#emu-phone-submit").addEventListener("click", function () { send("feedback"); });
  toolbar.querySelector("#emu-phone-accept").addEventListener("click", function () { send("accept"); });

  (function watchLiveReload() {
    var current = null;
    var lastState = "";
    var timer = null;
    var inflight = null;
    var dot = document.getElementById("emu-phone-live-dot");
    var label = document.getElementById("emu-phone-live-label");

    function setAgentUi(mode) {
      var busy = mode === "progress";
      var on = mode === "live" || busy;
      toolbar.style.display = busy ? "none" : "";
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
    }

    function schedule(ms) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, ms);
    }

    function tick() {
      if (document.hidden) {
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
          lastState = data.state === "progress" ? "progress" : "listening";
          setAgentUi(lastState === "progress" ? "progress" : "live");
          if (current === null) {
            current = String(data.v);
            return;
          }
          if (String(data.v) !== current) {
            window.location.reload();
            return;
          }
          current = String(data.v);
        })
        .catch(function (err) {
          if (err && err.name === "AbortError") return;
          setAgentUi("off");
        })
        .finally(function () {
          inflight = null;
          if (!document.hidden) schedule(250);
        });
    }

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        if (timer) clearTimeout(timer);
        tick();
      } else if (inflight && inflight.abort) {
        inflight.abort();
      }
    });
    tick();
  })();
})();
