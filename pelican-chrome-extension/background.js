importScripts("shared.js");

const {
  DEFAULT_API_BASE,
  DEFAULT_API_KEY,
  TIER_ORDER,
  extractRenderableCode,
  fastHash,
  isModelOpenSource,
  inferShortVendor
} = globalThis.PelicanShared;

const STORAGE_KEYS = {
  CONFIG: "pelican_ext_config_v1",
  LATEST: "pelican_ext_latest_v1",
  HISTORY: "pelican_ext_history_v1",
  LAST_FOCUS_HASH: "pelican_ext_last_focus_hash_v1"
};

const verdictMemCache = new Map();
const inflightRequests = new Map();
let creatingOffscreen = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getConfig() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
  const cfg = data[STORAGE_KEYS.CONFIG] || {};
  return {
    apiBase: String(cfg.apiBase || DEFAULT_API_BASE).replace(/\/+$/, ""),
    apiKey: String(cfg.apiKey || DEFAULT_API_KEY),
    autoPopup: cfg.autoPopup !== false,
    sourceFilter: cfg.sourceFilter || "all"
  };
}

async function getLastFocusHash() {
  try {
    const area = chrome.storage.session || chrome.storage.local;
    const d = await area.get(STORAGE_KEYS.LAST_FOCUS_HASH);
    return d[STORAGE_KEYS.LAST_FOCUS_HASH] || "";
  } catch (_) {
    return "";
  }
}

async function setLastFocusHash(h) {
  try {
    const area = chrome.storage.session || chrome.storage.local;
    await area.set({ [STORAGE_KEYS.LAST_FOCUS_HASH]: h || "" });
  } catch (_) {}
}

async function ensureDefaults() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
  if (!data[STORAGE_KEYS.CONFIG]) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.CONFIG]: {
        apiBase: DEFAULT_API_BASE,
        apiKey: DEFAULT_API_KEY,
        autoPopup: true,
        sourceFilter: "all"
      }
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaults();
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: "pelican-identify-selection",
        title: "使用鹈鹕实验室鉴定选中的 SVG / HTML 模型",
        contexts: ["selection"]
      });
      chrome.contextMenus.create({
        id: "pelican-identify-clipboard",
        title: "读取最新剪贴板并打开鹈鹕鉴定小窗",
        contexts: ["page"]
      });
    });
  } catch (_) {}
});

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  if (chrome.runtime.getContexts) {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    if (existing.length > 0) return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
  } else {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["CLIPBOARD"],
      justification: "实时读取剪贴板中的最新 SVG 或 HTML 源码并鉴定模型型号"
    });
    try {
      await creatingOffscreen;
    } catch (err) {
      if (!String(err).includes("Only a single offscreen")) {
        throw err;
      }
    } finally {
      creatingOffscreen = null;
    }
  }
}

async function readSystemClipboardViaOffscreen() {
  await ensureOffscreenDocument();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "OFFSCREEN_READ_CLIPBOARD"
      });
      if (res && res.ok) {
        return typeof res.text === "string" ? res.text : "";
      }
    } catch (_) {}
    await sleep(35 * (attempt + 1));
  }
  return "";
}

async function runIdentifyRequest(rawCode, codeType = "SVG", forceBypassCache = false) {
  const hash = fastHash(rawCode);
  await setLastFocusHash(hash);

  if (!forceBypassCache && verdictMemCache.has(hash)) {
    const cached = verdictMemCache.get(hash);
    await persistLatestAndHistory(rawCode, codeType, hash, cached);
    return { ok: true, verdict: cached, hash, cached: true };
  }

  if (inflightRequests.has(hash)) {
    return inflightRequests.get(hash);
  }

  const reqPromise = (async () => {
    try {
      const cfg = await getConfig();
      const t0 = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);

      let resp;
      try {
        resp = await fetch(`${cfg.apiBase}/api/v1/identify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": cfg.apiKey
          },
          body: JSON.stringify({ html: rawCode, code: rawCode }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      const json = await resp.json();
      if (!json || !json.detectedModel) {
        throw new Error(json && json.error ? json.error : "识别返回格式异常");
      }

      json.elapsedMs = json.elapsedMs || (Date.now() - t0);

      if (Array.isArray(json.allModels)) {
        json.allModels = json.allModels.map((m) => ({
          id: m.id,
          label: m.label,
          vendor: m.vendor,
          probability: m.probability,
          rarity: m.rarity,
          arenaRank: m.arenaRank
        }));
      }

      verdictMemCache.set(hash, json);
      if (verdictMemCache.size > 40) {
        const oldestKey = verdictMemCache.keys().next().value;
        verdictMemCache.delete(oldestKey);
      }

      await persistLatestAndHistory(rawCode, codeType, hash, json);
      return { ok: true, verdict: json, hash, cached: false };
    } finally {
      inflightRequests.delete(hash);
    }
  })();

  inflightRequests.set(hash, reqPromise);
  return reqPromise;
}

function buildDisplayLabel(vendor, model) {
  const v = String(vendor || "").trim();
  const m = String(model || "").trim();
  if (!v || v.toLowerCase() === "other") return m || "Unknown";
  if (m.toLowerCase().startsWith(v.toLowerCase())) return m;
  if (v.toLowerCase() === "gpt" && /^\d/.test(m)) return `GPT-${m}`;
  return `${v} ${m}`;
}

async function submitSampleToBackend({ rawCode, codeType, vendor, model, tier, isCorrection, baseVerdict }) {
  const parsed = extractRenderableCode(rawCode);
  if (!parsed || parsed.code.length < 40) {
    throw new Error("源码过短（至少需 40 字符有效 SVG / HTML）");
  }

  const cleanVendor = String(vendor || "").trim() || "Other";
  const cleanModel = String(model || "").trim();
  if (!cleanModel) {
    throw new Error("请填写或选择正确的模型型号");
  }
  const cleanTier = TIER_ORDER.includes(String(tier || "").toLowerCase())
    ? String(tier).toLowerCase()
    : "high";

  const cfg = await getConfig();
  const hash = fastHash(parsed.code);
  const sourceKey = `ext_${hash}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  let resp;
  try {
    resp = await fetch(`${cfg.apiBase}/api/v1/samples`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": cfg.apiKey
      },
      body: JSON.stringify({
        vendor: cleanVendor,
        model: cleanModel,
        tier: cleanTier,
        html: parsed.code,
        isCorrection: Boolean(isCorrection),
        skipIdentify: true,
        sourceKey
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data || !data.ok) {
    throw new Error((data && data.error) || `入库失败 (HTTP ${resp.status})`);
  }

  const savedItem = data.item || null;
  const savedDisplay =
    (savedItem && savedItem.displayModel) || buildDisplayLabel(cleanVendor, cleanModel);
  const shortV = inferShortVendor(`${cleanVendor} ${savedDisplay}`);

  // Update cached & persisted verdict so UI immediately reflects the confirmed ground-truth
  const prev = baseVerdict || verdictMemCache.get(hash) || {};
  const nextDetected = {
    ...(prev.detectedModel || {}),
    id: (savedItem && savedItem.subModelId) || `${cleanVendor}-${cleanModel}`.toLowerCase(),
    label: savedDisplay,
    vendor: shortV === "Other" ? cleanVendor : shortV,
    probability: 1,
    rarity: (savedItem && savedItem.rarity) || "normal",
    arenaRank: (savedItem && savedItem.arenaRank) || null
  };

  const prevList = Array.isArray(prev.allModels)
    ? prev.allModels.filter((m) => String(m.label || "").toLowerCase() !== savedDisplay.toLowerCase())
    : [];

  const updatedVerdict = {
    ...prev,
    ok: true,
    vendor: nextDetected.vendor,
    model: cleanModel,
    effortTier: cleanTier,
    effortConfidence: 1,
    tierProbabilities: TIER_ORDER.map((t) => ({ tier: t, probability: t === cleanTier ? 1 : 0 })),
    detectedModel: nextDetected,
    topModels: [nextDetected, ...prevList.slice(0, 4)],
    allModels: [nextDetected, ...prevList],
    exactArchiveMatch: { matched: true, specimenId: savedItem ? savedItem.id : sourceKey },
    userIngested: {
      vendor: cleanVendor,
      model: cleanModel,
      displayModel: savedDisplay,
      tier: cleanTier,
      isCorrection: Boolean(isCorrection),
      specimenId: savedItem ? savedItem.id : "",
      ts: Date.now()
    }
  };

  verdictMemCache.set(hash, updatedVerdict);
  await persistLatestAndHistory(parsed.code, codeType || parsed.type, hash, updatedVerdict);

  return {
    ok: true,
    hash,
    displayModel: savedDisplay,
    tier: cleanTier,
    isCorrection: Boolean(isCorrection),
    item: savedItem,
    verdict: updatedVerdict
  };
}

async function persistLatestAndHistory(code, type, hash, verdict) {
  const det = verdict.detectedModel || { label: "Unknown", vendor: "Other" };
  const safeCode = code.length <= 350000 ? code : code.slice(0, 350000);
  const entry = {
    hash,
    code: safeCode,
    type,
    ts: Date.now(),
    label: det.label,
    vendor: det.vendor,
    rarity: verdict.rarity || det.rarity || "normal",
    tier: verdict.effortTier || "high",
    probability: det.probability || 0,
    isOpen: isModelOpenSource(det),
    ingested: Boolean(verdict.userIngested),
    verdict
  };

  const store = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  let hist = Array.isArray(store[STORAGE_KEYS.HISTORY]) ? store[STORAGE_KEYS.HISTORY] : [];
  hist = hist.filter((x) => x.hash !== hash);
  hist.unshift(entry);
  if (hist.length > 10) hist = hist.slice(0, 10);

  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.LATEST]: entry,
      [STORAGE_KEYS.HISTORY]: hist
    });
  } catch (_) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.LATEST]: entry,
      [STORAGE_KEYS.HISTORY]: hist.slice(0, 4)
    });
  }
}

// Context Menu & Shortcut Handlers
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  if (info.menuItemId === "pelican-identify-selection" && info.selectionText) {
    const parsed = extractRenderableCode(info.selectionText);
    if (parsed) {
      chrome.tabs.sendMessage(tab.id, {
        type: "SHOW_PELICAN_FLOATING_PREVIEW",
        code: parsed.code,
        codeType: parsed.type,
        trigger: "右键选中代码"
      }).catch(() => {});
    }
  } else if (info.menuItemId === "pelican-identify-clipboard") {
    const clipText = await readSystemClipboardViaOffscreen();
    const parsed = extractRenderableCode(clipText);
    if (parsed) {
      chrome.tabs.sendMessage(tab.id, {
        type: "SHOW_PELICAN_FLOATING_PREVIEW",
        code: parsed.code,
        codeType: parsed.type,
        trigger: "右键读取剪贴板"
      }).catch(() => {});
    }
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "identify-clipboard") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  const clipText = await readSystemClipboardViaOffscreen();
  const parsed = extractRenderableCode(clipText);
  if (parsed) {
    chrome.tabs.sendMessage(tab.id, {
      type: "SHOW_PELICAN_FLOATING_PREVIEW",
      code: parsed.code,
      codeType: parsed.type,
      trigger: "快捷键唤醒"
    }).catch(() => {});
  } else {
    chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PELICAN_WINDOW" }).catch(() => {});
  }
});

// Runtime Message Router
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.target === "offscreen") return false;

  if (msg.type === "READ_RAW_CLIPBOARD") {
    (async () => {
      try {
        const text = await readSystemClipboardViaOffscreen();
        const parsed = extractRenderableCode(text);
        sendResponse({
          ok: true,
          text,
          hasCode: Boolean(parsed),
          code: parsed ? parsed.code : "",
          codeType: parsed ? parsed.type : "",
          hash: parsed ? fastHash(parsed.code) : ""
        });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (msg.type === "IDENTIFY_CODE") {
    (async () => {
      try {
        const cfg = await getConfig();
        if (msg.autoTriggered && !cfg.autoPopup) {
          sendResponse({ ok: false, skipped: true });
          return;
        }
        const parsed = extractRenderableCode(msg.code);
        if (!parsed) {
          sendResponse({ ok: false, error: "未检测到有效的 SVG 或 HTML 代码" });
          return;
        }
        const result = await runIdentifyRequest(parsed.code, parsed.type, Boolean(msg.forceBypassCache));
        sendResponse({ ...result, code: parsed.code, codeType: parsed.type });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg.type === "SUBMIT_SAMPLE") {
    (async () => {
      try {
        const res = await submitSampleToBackend({
          rawCode: msg.code,
          codeType: msg.codeType,
          vendor: msg.vendor,
          model: msg.model,
          tier: msg.tier,
          isCorrection: msg.isCorrection,
          baseVerdict: msg.baseVerdict
        });
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg.type === "CHECK_SYSTEM_CLIPBOARD") {
    (async () => {
      try {
        const cfg = await getConfig();
        if (msg.autoTriggered && !cfg.autoPopup) {
          sendResponse({ ok: false, skipped: true });
          return;
        }
        const clipText = await readSystemClipboardViaOffscreen();
        const parsed = extractRenderableCode(clipText);
        if (!parsed) {
          if (clipText && clipText.trim().length > 0) {
            await setLastFocusHash("NON_CODE_" + fastHash(clipText.slice(0, 512)));
          }
          sendResponse({ ok: false, hasCode: false });
          return;
        }
        const h = fastHash(parsed.code);
        if (msg.onlyIfChanged) {
          const prevHash = await getLastFocusHash();
          if (h === prevHash) {
            sendResponse({ ok: false, duplicate: true, hash: h });
            return;
          }
        }
        const result = await runIdentifyRequest(parsed.code, parsed.type);
        sendResponse({ ...result, code: parsed.code, codeType: parsed.type, hasCode: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (msg.type === "GET_STATE") {
    (async () => {
      const cfg = await getConfig();
      const store = await chrome.storage.local.get([STORAGE_KEYS.LATEST, STORAGE_KEYS.HISTORY]);
      sendResponse({
        ok: true,
        config: cfg,
        latest: store[STORAGE_KEYS.LATEST] || null,
        history: store[STORAGE_KEYS.HISTORY] || []
      });
    })();
    return true;
  }

  if (msg.type === "SAVE_CONFIG") {
    (async () => {
      const cur = await getConfig();
      const next = { ...cur, ...(msg.patch || {}) };
      await chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: next });
      sendResponse({ ok: true, config: next });
    })();
    return true;
  }

  return false;
});
