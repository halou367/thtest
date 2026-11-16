(function () {
  "use strict";
  const {
    DEFAULT_CAPTURE_KEYWORDS,
    TIER_ORDER,
    TIER_SHORT,
    SHORT_VENDOR_CATALOG,
    escapeHtml,
    fastHash,
    extractRenderableCode,
    matchKeywordFeatures,
    extractSanitizedSvgMarkup,
    splitToShortVendorAndModel,
    getModelsForVendor,
    getVendorLogoSvg,
    computeFilteredVerdict
  } = window.PelicanShared;

  let sourceFilter = "all";
  let currentCode = "";
  let currentHash = "";
  let currentType = "SVG";
  let currentMatchedKws = [];
  let currentVerdict = null;
  let currentOpenThinking = null;
  let captureKeywordsStr = DEFAULT_CAPTURE_KEYWORDS;
  let pageSpecimens = [];

  let detailsOpen = false;
  let correctOpen = false;
  let submittingSample = false;

  let corrTier = "high";
  let detectedVendor = "";
  let detectedModel = "";
  let detectedTier = "high";

  let renderSeq = 0;
  let activeTimer = null;
  const acked = new Set();

  const frame = document.getElementById("popupPreviewFrame");
  frame.src = chrome.runtime.getURL("sandbox-preview.html?cid=popup");

  document.getElementById("corrVendorSelect").innerHTML = SHORT_VENDOR_CATALOG.map(
    (v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.id)}</option>`
  ).join("");

  window.addEventListener("message", (ev) => {
    const d = ev && ev.data;
    if (!d || d.type !== "PELICAN_RENDER_ACK" || d.cid !== "popup") return;
    acked.add(d.renderId);
    if (activeTimer) {
      clearInterval(activeTimer);
      activeTimer = null;
    }
    const fb = document.getElementById("svgFallbackStage");
    if (fb) fb.style.display = "none";
  });

  function sendCodeToPreview(code) {
    if (activeTimer) {
      clearInterval(activeTimer);
      activeTimer = null;
    }

    const fb = document.getElementById("svgFallbackStage");
    const safeSvg = extractSanitizedSvgMarkup(code);
    if (fb) {
      if (safeSvg) {
        fb.innerHTML = safeSvg;
        fb.style.display = "flex";
      } else {
        fb.innerHTML = "";
        fb.style.display = "none";
      }
    }

    const renderId = `popup_${++renderSeq}`;
    let attempts = 0;
    const post = () => {
      attempts++;
      if (acked.has(renderId) || attempts > 28) {
        if (activeTimer) {
          clearInterval(activeTimer);
          activeTimer = null;
        }
        return;
      }
      try {
        if (frame.contentWindow) {
          frame.contentWindow.postMessage({ type: "PELICAN_RENDER_CODE", cid: "popup", renderId, code }, "*");
        }
      } catch (_) {}
    };
    post();
    activeTimer = setInterval(post, 75);
  }

  let toastTimer = null;
  function showInlineToast(text, isErr = false) {
    const el = document.getElementById("inlineToast");
    el.textContent = text;
    el.className = `toast-inline show${isErr ? " err" : ""}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 4000);
  }

  function switchTab(tabId) {
    document.querySelectorAll(".nav-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tabId));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${tabId}`));
    if (tabId === "result" && currentCode) {
      sendCodeToPreview(currentCode);
    }
  }
  document.querySelectorAll(".nav-tab").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

  function syncPills() {
    document.querySelectorAll(".source-pill-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.filter === sourceFilter);
    });
  }

  document.querySelectorAll(".source-pill-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.filter;
      sourceFilter = sourceFilter === target && target !== "all" ? "all" : target;
      syncPills();
      renderVerdict();
      chrome.runtime.sendMessage({ type: "SAVE_CONFIG", patch: { sourceFilter } });
    });
  });

  function renderSpecimensBar() {
    const bar = document.getElementById("pageSpecimensBar");
    const btnScan = document.getElementById("btnScanTab");
    btnScan.textContent = pageSpecimens.length > 0 ? `🔍 本页(${pageSpecimens.length})` : "🔍 抓本页";

    if (pageSpecimens.length <= 1) {
      bar.classList.remove("show");
      bar.innerHTML = "";
      return;
    }

    bar.classList.add("show");
    bar.innerHTML = pageSpecimens
      .map((it, idx) => {
        const kb = (it.code.length / 1024).toFixed(1);
        const kwTag = it.kwHit && it.matchedKws && it.matchedKws.length ? ` 🎯${it.matchedKws[0]}` : "";
        const isAct = it.hash === currentHash ? "active" : "";
        return `<button type="button" class="spec-tab ${isAct}" data-spec-idx="${idx}">#${idx + 1} ${it.type} ${kb}K${escapeHtml(kwTag)}</button>`;
      })
      .join("");

    bar.querySelectorAll("[data-spec-idx]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const item = pageSpecimens[Number(btn.dataset.specIdx)];
        if (!item) return;
        await identifyAndDisplaySpecimen(item.code, item.origin, item.matchedKws);
      });
    });
  }

  async function identifyAndDisplaySpecimen(code, originLbl = "", matchedKwsOpt = null) {
    const parsed = extractRenderableCode(code);
    if (!parsed) return;
    currentCode = parsed.code;
    currentHash = fastHash(parsed.code);
    currentType = parsed.type;
    const kwRes = matchKeywordFeatures(parsed.code, captureKeywordsStr);
    currentMatchedKws = Array.isArray(matchedKwsOpt) ? matchedKwsOpt : kwRes.matched;

    renderSpecimensBar();
    document.getElementById("emptyState").style.display = "none";
    document.getElementById("resultContent").style.display = "flex";
    switchTab("result");

    const kb = (parsed.code.length / 1024).toFixed(1);
    document.getElementById("statusSub").textContent = `${originLbl ? originLbl + "·" : ""}${parsed.type} ${kb}K`;
    document.getElementById("heroTitle").textContent = "正在识别模型...";
    sendCodeToPreview(parsed.code);

    const res = await chrome.runtime.sendMessage({
      type: "IDENTIFY_CODE",
      code: parsed.code,
      autoTriggered: false
    });
    if (res && res.ok && res.verdict) {
      currentVerdict = res.verdict;
      document.getElementById("statusSub").textContent = `${parsed.type} ${kb}K · ${res.verdict.elapsedMs || 10}ms`;
      renderVerdict();
    } else {
      showInlineToast((res && res.error) || "识别失败", true);
    }
  }

  function syncCorrectionModeLabel() {
    const v = document.getElementById("corrVendorSelect").value.trim();
    const m = document.getElementById("corrModelInput").value.trim();
    const isChanged =
      v.toLowerCase() !== detectedVendor.toLowerCase() ||
      m.toLowerCase() !== detectedModel.toLowerCase() ||
      corrTier !== detectedTier;

    const hint = document.getElementById("corrModeHint");
    const btn = document.getElementById("btnSubmitIngest");
    if (isChanged) {
      hint.textContent = "已修改 · 纠错入库";
      hint.style.color = "#b45309";
      if (!submittingSample) btn.textContent = "纠正并入库";
    } else {
      hint.textContent = "一致 · 确认归档";
      hint.style.color = "#1f5f4b";
      if (!submittingSample) btn.textContent = "确认入库";
    }
  }

  function renderVendorPresetChips() {
    const vendor = document.getElementById("corrVendorSelect").value;
    const curModel = document.getElementById("corrModelInput").value.trim().toLowerCase();
    const extra = currentVerdict && currentVerdict.allModels ? currentVerdict.allModels : [];
    const models = getModelsForVendor(vendor, extra);
    const wrap = document.getElementById("vendorModelChips");
    if (!models.length) {
      wrap.style.display = "none";
      wrap.innerHTML = "";
      return;
    }
    wrap.style.display = "flex";
    wrap.innerHTML = models
      .slice(0, 12)
      .map(
        (m) =>
          `<button type="button" class="quick-chip ${m.toLowerCase() === curModel ? "sel" : ""}" data-preset-model="${escapeHtml(m)}">${escapeHtml(m)}</button>`
      )
      .join("");
    wrap.querySelectorAll("[data-preset-model]").forEach((b) => {
      b.addEventListener("click", () => {
        document.getElementById("corrModelInput").value = b.dataset.presetModel;
        renderVendorPresetChips();
        syncCorrectionModeLabel();
      });
    });
  }

  function applyCorrectionSelection(vendorRaw, labelOrShortModel, tierOpt) {
    const sp = splitToShortVendorAndModel(vendorRaw, labelOrShortModel);
    const vSel = document.getElementById("corrVendorSelect");
    const found = SHORT_VENDOR_CATALOG.find((x) => x.id.toLowerCase() === sp.shortVendor.toLowerCase());
    vSel.value = found ? found.id : "Other";
    document.getElementById("corrModelInput").value = sp.shortModel;
    if (tierOpt && TIER_ORDER.includes(tierOpt)) {
      corrTier = tierOpt;
      document.querySelectorAll("#corrTierGroup .tier-pick-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.tier === corrTier);
      });
    }
    renderVendorPresetChips();
    syncCorrectionModeLabel();
  }

  document.getElementById("btnToggleCorrect").addEventListener("click", () => {
    correctOpen = !correctOpen;
    document.getElementById("correctDrawer").classList.toggle("open", correctOpen);
    document.getElementById("btnToggleCorrect").classList.toggle("active", correctOpen);
  });

  document.getElementById("btnToggleDetails").addEventListener("click", () => {
    detailsOpen = !detailsOpen;
    document.getElementById("detailsDrawer").classList.toggle("open", detailsOpen);
    document.getElementById("btnToggleDetails").classList.toggle("active", detailsOpen);
    document.getElementById("btnToggleDetails").textContent = detailsOpen ? "收起 ▴" : "详情 ▾";
  });

  document.getElementById("corrVendorSelect").addEventListener("change", (e) => {
    const models = getModelsForVendor(e.target.value, currentVerdict?.allModels);
    if (models.length) document.getElementById("corrModelInput").value = models[0];
    renderVendorPresetChips();
    syncCorrectionModeLabel();
  });
  document.getElementById("corrModelInput").addEventListener("input", () => {
    renderVendorPresetChips();
    syncCorrectionModeLabel();
  });
  document.querySelectorAll("#corrTierGroup .tier-pick-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      corrTier = btn.dataset.tier;
      document.querySelectorAll("#corrTierGroup .tier-pick-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.tier === corrTier);
      });
      syncCorrectionModeLabel();
    });
  });

  document.getElementById("btnSubmitIngest").addEventListener("click", async () => {
    if (submittingSample || !currentCode) return;
    const vendor = document.getElementById("corrVendorSelect").value.trim();
    const model = document.getElementById("corrModelInput").value.trim();
    if (!model) {
      showInlineToast("请输入或点选正确的模型型号", true);
      return;
    }
    const isCorrection =
      vendor.toLowerCase() !== detectedVendor.toLowerCase() ||
      model.toLowerCase() !== detectedModel.toLowerCase() ||
      corrTier !== detectedTier;

    const btn = document.getElementById("btnSubmitIngest");
    submittingSample = true;
    btn.disabled = true;
    btn.textContent = "入库中...";
    try {
      const res = await chrome.runtime.sendMessage({
        type: "SUBMIT_SAMPLE",
        code: currentCode,
        codeType: currentType,
        vendor,
        model,
        tier: corrTier,
        isCorrection,
        baseVerdict: currentVerdict
      });
      if (res && res.ok) {
        if (res.verdict) {
          currentVerdict = res.verdict;
          renderVerdict();
        }
        correctOpen = false;
        document.getElementById("correctDrawer").classList.remove("open");
        document.getElementById("btnToggleCorrect").classList.remove("active");
        showInlineToast(`✓ 已${isCorrection ? "纠错" : "归档"}入库：${res.displayModel} (${corrTier.toUpperCase()})`);
      } else {
        showInlineToast((res && res.error) || "入库失败", true);
      }
    } finally {
      submittingSample = false;
      btn.disabled = false;
      syncCorrectionModeLabel();
    }
  });

  function renderVerdict() {
    if (!currentVerdict) return;
    document.getElementById("emptyState").style.display = "none";
    document.getElementById("resultContent").style.display = "flex";

    const calc = computeFilteredVerdict(currentVerdict, sourceFilter);
    if (!calc) return;
    const { rawList, filtered, poolSum, openSharePct, closedSharePct, overallTop, activeTop, probPct, exactHit } = calc;

    document.getElementById("pctAll").textContent = `${rawList.length}`;
    document.getElementById("pctOpen").textContent = `${openSharePct}%`;
    document.getElementById("pctClosed").textContent = `${closedSharePct}%`;

    const rarity = activeTop.rarity || "normal";
    const rank = activeTop.arenaRank || null;
    const tierKey = TIER_ORDER.includes(currentVerdict.effortTier) ? currentVerdict.effortTier : "high";
    const tierStr = TIER_SHORT[tierKey] || tierKey.toUpperCase();

    document.getElementById("verdictCard").className = `verdict-card rarity-${rarity}`;
    document.getElementById("heroLogo").innerHTML = getVendorLogoSvg(activeTop.vendor || activeTop.label, 23);
    document.getElementById("heroTitle").textContent = activeTop.label;
    document.getElementById("confPct").textContent = `${probPct}%`;

    // v1.5.0 极简：只留一行小字，无彩色徽章
    let sub = `${activeTop.isOpen ? "开源" : "闭源"} · ${tierStr}`;
    if (currentVerdict.userIngested) sub += ` · 已${currentVerdict.userIngested.isCorrection ? "纠错" : "归档"}入库`;
    else if (exactHit && activeTop.id === overallTop.id) sub += " · 馆藏命中";
    document.getElementById("heroBadges").innerHTML = `<span class="hero-sub">${escapeHtml(sub)}</span>`;

    const detSplit = splitToShortVendorAndModel(activeTop.vendor, activeTop.label);
    detectedVendor = detSplit.shortVendor;
    detectedModel = detSplit.shortModel;
    detectedTier = tierKey;
    applyCorrectionSelection(activeTop.vendor, activeTop.label, tierKey);

    const quickCands = filtered.slice(0, 4);
    const qcWrap = document.getElementById("candidateQuickChips");
    qcWrap.innerHTML = quickCands
      .map((m, i) => `<button type="button" class="quick-chip" data-cand-idx="${i}">${escapeHtml(m.label)}</button>`)
      .join("");
    qcWrap.querySelectorAll("[data-cand-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const chosen = quickCands[Number(btn.dataset.candIdx)];
        if (chosen) applyCorrectionSelection(chosen.vendor, chosen.label, corrTier);
      });
    });

    const tierMap = {};
    (currentVerdict.tierProbabilities || []).forEach((tp) => { tierMap[tp.tier] = tp.probability; });
    const effConf = currentVerdict.effortConfidence ?? tierMap[tierKey] ?? 0;
    document.getElementById("effortSummaryLbl").textContent = `${tierStr} (${Math.round(effConf * 100)}%)`;

    document.getElementById("tierGrid").innerHTML = TIER_ORDER.map((t) => {
      const p = (tierMap[t] || 0) * 100;
      return `<div class="tier-mini-cell ${t === tierKey ? "active" : ""}">${TIER_SHORT[t]} ${p.toFixed(0)}%</div>`;
    }).join("");

    const top5 = filtered.slice(0, 5);
    document.getElementById("candBars").innerHTML = top5
      .map((m, idx) => {
        const normP =
          sourceFilter === "all"
            ? (Number(m.probability) || 0) * 100
            : poolSum > 0.0005
            ? ((Number(m.probability) || 0) / poolSum) * 100
            : 0;
        const pct = Math.min(100, Math.max(0, normP));
        return `<div class="cand-row" data-pick-top="${idx}">
          ${getVendorLogoSvg(m.vendor || m.label, 17)}
          <div>
            <div class="cand-name">${escapeHtml(m.label)}</div>
            <div class="prob-track"><div class="prob-fill" style="width:${pct.toFixed(1)}%;background:${m.isOpen ? "#2b7a61" : "#4f6d8a"};"></div></div>
          </div>
          <div class="cand-pct">${pct.toFixed(1)}%</div>
        </div>`;
      })
      .join("");

    document.querySelectorAll("[data-pick-top]").forEach((row) => {
      row.addEventListener("click", () => {
        const picked = top5[Number(row.dataset.pickTop)];
        if (!picked) return;
        correctOpen = true;
        document.getElementById("correctDrawer").classList.add("open");
        document.getElementById("btnToggleCorrect").classList.add("active");
        applyCorrectionSelection(picked.vendor, picked.label, corrTier);
      });
    });
  }

  async function scanCurrentTabSpecimens(showEmptyNotice = true) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return false;
      const resp = await chrome.tabs.sendMessage(tab.id, { type: "SCAN_PAGE_SPECIMENS" });
      if (resp && resp.ok && Array.isArray(resp.specimens) && resp.specimens.length > 0) {
        pageSpecimens = resp.specimens;
        const top = pageSpecimens[0];
        await identifyAndDisplaySpecimen(top.code, top.origin, top.matchedKws);
        return true;
      }
      if (showEmptyNotice) {
        document.getElementById("statusSub").textContent = "本页无目标代码";
      }
    } catch (_) {
      if (showEmptyNotice) {
        document.getElementById("statusSub").textContent = "无法扫描此系统页";
      }
    }
    return false;
  }

  async function checkClipboardNow() {
    const btn = document.getElementById("btnCheckClip");
    btn.textContent = "读取中...";
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch (_) {}

    if (text) {
      const parsed = extractRenderableCode(text);
      if (parsed) {
        await identifyAndDisplaySpecimen(parsed.code, "剪贴板");
        btn.textContent = "📋 剪贴板";
        return;
      }
    }

    const res = await chrome.runtime.sendMessage({
      type: "CHECK_SYSTEM_CLIPBOARD",
      autoTriggered: false,
      onlyIfChanged: false
    });
    btn.textContent = "📋 剪贴板";
    if (res && res.ok && res.verdict && res.code) {
      currentCode = res.code;
      currentHash = res.hash || fastHash(res.code);
      currentType = res.codeType || "SVG";
      currentMatchedKws = matchKeywordFeatures(res.code, captureKeywordsStr).matched;
      currentVerdict = res.verdict;
      document.getElementById("statusSub").textContent = `${currentType} · ${(res.code.length / 1024).toFixed(1)}K`;
      sendCodeToPreview(currentCode);
      renderVerdict();
      switchTab("result");
    } else {
      document.getElementById("statusSub").textContent = "剪贴板无 SVG/HTML";
    }
  }

  document.getElementById("btnScanTab").addEventListener("click", () => scanCurrentTabSpecimens(true));
  document.getElementById("btnCheckClip").addEventListener("click", checkClipboardNow);

  document.getElementById("btnPopInTab").addEventListener("click", async () => {
    if (!currentCode) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "SHOW_PELICAN_FLOATING_PREVIEW", code: currentCode });
        window.close();
      } catch (_) {
        showInlineToast("当前浏览器系统页面不支持注入浮窗", true);
      }
    }
  });

  document.getElementById("btnClearPaste").addEventListener("click", () => {
    document.getElementById("pasteInput").value = "";
  });

  document.getElementById("btnRunPaste").addEventListener("click", async () => {
    const raw = document.getElementById("pasteInput").value;
    const parsed = extractRenderableCode(raw);
    if (!parsed) {
      alert("未检测到有效的 SVG 或 HTML 代码！");
      return;
    }
    await identifyAndDisplaySpecimen(parsed.code, "手动粘贴");
  });

  document.getElementById("btnResetDefaultKws").addEventListener("click", () => {
    document.getElementById("cfgCaptureKeywords").value = DEFAULT_CAPTURE_KEYWORDS;
  });

  document.getElementById("btnSaveCfg").addEventListener("click", async () => {
    const patch = {
      autoPageCapture: document.getElementById("cfgAutoPageCapture").checked,
      keywordOnlyAuto: document.getElementById("cfgKeywordOnlyAuto").checked,
      autoPopup: document.getElementById("cfgAutoPopup").checked,
      captureKeywords: document.getElementById("cfgCaptureKeywords").value.trim() || DEFAULT_CAPTURE_KEYWORDS,
      apiBase: document.getElementById("cfgApiBase").value.trim() || "https://th.629717.cc.cd",
      apiKey: document.getElementById("cfgApiKey").value.trim() || "1234567890"
    };
    captureKeywordsStr = patch.captureKeywords;
    await chrome.runtime.sendMessage({ type: "SAVE_CONFIG", patch });
    const toast = document.getElementById("saveToast");
    toast.textContent = "✓ 已保存";
    setTimeout(() => { toast.textContent = ""; }, 2000);
  });

  (async function init() {
    const st = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (st && st.config) {
      sourceFilter = st.config.sourceFilter || "all";
      captureKeywordsStr = st.config.captureKeywords || DEFAULT_CAPTURE_KEYWORDS;
      syncPills();
      document.getElementById("cfgAutoPageCapture").checked = st.config.autoPageCapture !== false;
      document.getElementById("cfgKeywordOnlyAuto").checked = Boolean(st.config.keywordOnlyAuto);
      document.getElementById("cfgAutoPopup").checked = st.config.autoPopup !== false;
      document.getElementById("cfgCaptureKeywords").value = captureKeywordsStr;
      document.getElementById("cfgApiBase").value = st.config.apiBase || "https://th.629717.cc.cd";
      document.getElementById("cfgApiKey").value = st.config.apiKey || "1234567890";
    }
    if (st && st.latest && st.latest.verdict && st.latest.code) {
      currentCode = st.latest.code;
      currentHash = st.latest.hash || fastHash(st.latest.code);
      currentType = st.latest.type || "SVG";
      currentMatchedKws = matchKeywordFeatures(currentCode, captureKeywordsStr).matched;
      currentVerdict = st.latest.verdict;
      currentOpenThinking = st.latest.openThinking || null;
      document.getElementById("statusSub").textContent = `${currentType} · ${(currentCode.length / 1024).toFixed(1)}K`;
      sendCodeToPreview(currentCode);
      renderVerdict();
      // Quietly fetch page specimens list for the switcher bar
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
          const resp = await chrome.tabs.sendMessage(tab.id, { type: "SCAN_PAGE_SPECIMENS" });
          if (resp && resp.ok && Array.isArray(resp.specimens)) {
            pageSpecimens = resp.specimens;
            renderSpecimensBar();
          }
        }
      } catch (_) {}
    } else {
      const scanned = await scanCurrentTabSpecimens(false);
      if (!scanned) await checkClipboardNow();
    }
  })();
})();
