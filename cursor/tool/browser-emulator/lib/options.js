const { VALID_PRESETS } = require("./cli");
const { parseBoolean } = require("./io");

function normalizeUrlInput(urlLike) {
  if (!urlLike) return "";
  const value = String(urlLike).trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value.replace(/^\/+/, "")}`;
}

function getPresetOptions(presetName, useCdp) {
  const preset = String(presetName || "balanced").toLowerCase();

  if (preset === "quick") {
    return {
      agentOverlayEnabled: false,
      captureDomAfterRun: false,
      captureScreenshotAfterRun: false,
      enableDomainCache: false,
      forgetPageAfterRun: false,
      forgetDomainCacheAfterRun: true,
      waitAfterActionMs: 150
    };
  }

  if (preset === "secure") {
    return {
      agentOverlayEnabled: true,
      captureDomAfterRun: true,
      captureScreenshotAfterRun: true,
      enableDomainCache: false,
      forgetPageAfterRun: true,
      forgetDomainCacheAfterRun: true,
      forgetSessionAfterRun: true,
      forgetArtifactsAfterRun: true,
      waitAfterActionMs: 250
    };
  }

  return {
    agentOverlayEnabled: useCdp,
    captureDomAfterRun: true,
    captureScreenshotAfterRun: true,
    enableDomainCache: true,
    forgetPageAfterRun: false,
    forgetDomainCacheAfterRun: false,
    forgetSessionAfterRun: false,
    forgetArtifactsAfterRun: false,
    waitAfterActionMs: 300
  };
}

function resolveRunOptions({ args, config, useCdp, liveMode }) {
  const presetForcedByArg = args.preset !== undefined;
  const rawPreset = String(args.preset || config.preset || "balanced").toLowerCase();
  const preset = VALID_PRESETS.has(rawPreset) ? rawPreset : "balanced";
  const presetOptions = getPresetOptions(preset, useCdp);

  let agentOverlayEnabled = parseBoolean(
    args.agentOverlayEnabled,
    parseBoolean(config.agentOverlayEnabled, useCdp)
  );
  const agentOverlayText = args.agentOverlayText || config.agentOverlayText || "Agent in progress";
  const agentOverlayDisableClicks = parseBoolean(
    args.agentOverlayDisableClicks,
    parseBoolean(config.agentOverlayDisableClicks, true)
  );
  const agentOverlayLockDuringActions = parseBoolean(
    args.agentOverlayLockDuringActions,
    parseBoolean(config.agentOverlayLockDuringActions, true)
  );
  const agentOverlayKeepAfterRun = parseBoolean(
    args.agentOverlayKeepAfterRun,
    parseBoolean(config.agentOverlayKeepAfterRun, false)
  );
  let forgetPageAfterRun = parseBoolean(
    args.forgetPageAfterRun,
    parseBoolean(config.forgetPageAfterRun, true)
  );
  let forgetDomainCacheAfterRun = parseBoolean(
    args.forgetDomainCacheAfterRun,
    parseBoolean(config.forgetDomainCacheAfterRun, true)
  );
  let forgetSessionAfterRun = parseBoolean(
    args.forgetSessionAfterRun,
    parseBoolean(config.forgetSessionAfterRun, false)
  );
  let forgetArtifactsAfterRun = parseBoolean(
    args.forgetArtifactsAfterRun,
    parseBoolean(config.forgetArtifactsAfterRun, false)
  );
  let enableDomainCache = parseBoolean(
    args.enableDomainCache,
    parseBoolean(config.enableDomainCache, !forgetDomainCacheAfterRun)
  );
  const maxDomainRuns = Math.max(
    1,
    Number(args.maxDomainRuns || config.maxDomainRuns || 100)
  );
  let captureDomAfterRun = parseBoolean(
    args.captureDomAfterRun,
    parseBoolean(config.captureDomAfterRun, true)
  );
  let captureScreenshotAfterRun = parseBoolean(
    args.captureScreenshotAfterRun,
    parseBoolean(config.captureScreenshotAfterRun, true)
  );

  let waitAfterActionMs = Number(presetOptions.waitAfterActionMs || 300);
  if (config.waitAfterActionMs !== undefined && !presetForcedByArg) {
    waitAfterActionMs = Number(config.waitAfterActionMs);
  }
  if (args.waitAfterActionMs !== undefined) {
    waitAfterActionMs = Number(args.waitAfterActionMs);
  }
  if (Number.isNaN(waitAfterActionMs) || waitAfterActionMs < 0) {
    waitAfterActionMs = 300;
  }

  if (args.agentOverlayEnabled === undefined && (config.agentOverlayEnabled === undefined || presetForcedByArg)) {
    agentOverlayEnabled = parseBoolean(presetOptions.agentOverlayEnabled, agentOverlayEnabled);
  }
  if (args.captureDomAfterRun === undefined && (config.captureDomAfterRun === undefined || presetForcedByArg)) {
    captureDomAfterRun = parseBoolean(presetOptions.captureDomAfterRun, captureDomAfterRun);
  }
  if (args.captureScreenshotAfterRun === undefined && (config.captureScreenshotAfterRun === undefined || presetForcedByArg)) {
    captureScreenshotAfterRun = parseBoolean(
      presetOptions.captureScreenshotAfterRun,
      captureScreenshotAfterRun
    );
  }
  if (args.forgetPageAfterRun === undefined && (config.forgetPageAfterRun === undefined || presetForcedByArg)) {
    forgetPageAfterRun = parseBoolean(presetOptions.forgetPageAfterRun, forgetPageAfterRun);
  }
  if (args.forgetDomainCacheAfterRun === undefined && (config.forgetDomainCacheAfterRun === undefined || presetForcedByArg)) {
    forgetDomainCacheAfterRun = parseBoolean(
      presetOptions.forgetDomainCacheAfterRun,
      forgetDomainCacheAfterRun
    );
  }
  if (args.forgetSessionAfterRun === undefined && (config.forgetSessionAfterRun === undefined || presetForcedByArg)) {
    forgetSessionAfterRun = parseBoolean(presetOptions.forgetSessionAfterRun, forgetSessionAfterRun);
  }
  if (args.forgetArtifactsAfterRun === undefined && (config.forgetArtifactsAfterRun === undefined || presetForcedByArg)) {
    forgetArtifactsAfterRun = parseBoolean(
      presetOptions.forgetArtifactsAfterRun,
      forgetArtifactsAfterRun
    );
  }
  if (args.enableDomainCache === undefined && (config.enableDomainCache === undefined || presetForcedByArg)) {
    enableDomainCache = parseBoolean(presetOptions.enableDomainCache, enableDomainCache);
  }

  const effectiveLiveMode = parseBoolean(liveMode, false);
  if (effectiveLiveMode) {
    // Live mode is optimized for iterative testing on a persistent browser state.
    forgetPageAfterRun = false;
    forgetDomainCacheAfterRun = false;
    forgetSessionAfterRun = false;
    forgetArtifactsAfterRun = false;
    captureDomAfterRun = true;
    captureScreenshotAfterRun = true;
    agentOverlayEnabled = true;
    if (waitAfterActionMs < 300) waitAfterActionMs = 300;
  }

  return {
    rawPreset,
    preset,
    agentOverlayEnabled,
    agentOverlayText,
    agentOverlayDisableClicks,
    agentOverlayLockDuringActions,
    agentOverlayKeepAfterRun,
    forgetPageAfterRun,
    forgetDomainCacheAfterRun,
    forgetSessionAfterRun,
    forgetArtifactsAfterRun,
    enableDomainCache,
    maxDomainRuns,
    captureDomAfterRun,
    captureScreenshotAfterRun,
    waitAfterActionMs
  };
}

module.exports = {
  normalizeUrlInput,
  getPresetOptions,
  resolveRunOptions
};

