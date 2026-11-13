(function () {
  "use strict";

  const {
    DEFAULT_API_BASE,
    DEFAULT_API_KEY,
    TIER_ORDER,
    TIER_SHORT,
    SHORT_VENDOR_CATALOG,
    escapeHtml,
    extractRenderableCode,
    extractSanitizedSvgMarkup,
    splitToShortVendorAndModel,
    getModelsForVendor,
    getVendorLogoSvg,
    computeFilteredVerdict
  } = window.PelicanShared;

  let renderSeq = 0;
  let ackedRenderId = "";
  let retryTimer = null;

  const state = {
    sourceFilter: "all",
    detailsOpen: false,
    correctOpen: false,
    submitting: false,
    currentCode: "",
    currentType: "SVG",
    currentVerdict: null,
    history: [],
    corrTier: "high",
    detectedVendor: "",
    detectedModel: "",
    detectedTier: "high"
  };

  window.addEventListener("message", (ev) => {
    const d = ev && ev.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "PELICAN_RENDER_ACK" && d.cid === "popup" && d.renderId) {
      ackedRenderId = d.renderId;
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
      const fb = document.getElementById("popupSvgFallback");
      if (fb) fb.style.display = "none";
    }
  });

  function postPreview(code) {
    const frame = document.getElementById("popupPreviewFrame");
    const fb = document.getElementById("popupSvgFallback");
    if (!frame) return;

    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }

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

    const tryPost = () => {
      attempts++;
      if (ackedRenderId === renderId || attempts > 30) {
        if (retryTimer) {
          clearInterval(retryTimer);
          retryTimer = null;
        }
        return;
      }
      try {
        if (frame.contentWindow) {
          frame.contentWindow.postMessage(
            {
              type: "PELICAN_RENDER_CODE",
              cid: "popup",
              renderId,
              code
            },
            "*"
          );
        }
      } catch (_) {}
    };

    tryPost();
    retryTimer = setInterval(tryPost, 65);
  }

  let toastTimer = null;
  function showInlineToast(text, isErr = false) {
    const el = document.getElementById("inlineToast");
    el.textContent = text;
    el.className = `toast-inline show${isErr ? " err" : ""}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 4200);
  }

  async function readLatestClipboardText() {
    try {
      const bgClip = await chrome.runtime.sendMessage({ type: "READ_RAW_CLIPBOARD" });
      if (bgClip && bgClip.ok && typeof bgClip.text === "string" && bgClip.text.length > 0) {
        return bgClip.text;
      }
    } catch (_) {}

    try {
      if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
        const txt = await navigator.clipboard.readText();
        if (txt) return txt;
      }
    } catch (_) {}

    return "";
  }

  function syncPillUI() {
    document.querySelectorAll(".source-pill-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.filter === state.sourceFilter);
    });
  }

  function syncCorrectionModeLabel() {
    const v = document.getElementById("corrVendorSelect").value.trim();
    const m = document.getElementById("corrModelInput").value.trim();
    const isChanged =
      v.toLowerCase() !== state.detectedVendor.toLowerCase() ||
      m.toLowerCase() !== state.detectedModel.toLowerCase() ||
      state.corrTier !== state.detectedTier;

    const hint = document.getElementById("corrModeHint");
    const btn = document.getElementById("btnSubmitIngest");
    if (isChanged) {
      hint.textContent = "已修改 · 纠错入库";
      hint.style.color = "#b45309";
      if (!state.submitting) btn.textContent = "纠正并入库";
    } else {
      hint.textContent = "一致 · 确认归档";
      hint.style.color = "#1f5f4b";
      if (!state.submitting) btn.textContent = "确认入库";
    }
  }

  function renderVendorPresetChips() {
    const vendor = document.getElementById("corrVendorSelect").value;
    const curModel = document.getElementById("corrModelInput").value.trim().toLowerCase();
    const extra = state.currentVerdict && state.currentVerdict.allModels ? state.currentVerdict.allModels : [];
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
    wrap.querySelectorAll("[data-preset-model]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById("corrModelInput").value = btn.dataset.presetModel;
        renderVendorPresetChips();
        syncCorrectionModeLabel();
      });
    });
  }

  function applyCorrectionSelection(vendorRaw, labelOrShortModel, tierOpt) {
    const sp = splitToShortVendorAndModel(vendorRaw, labelOrShortModel);
    const vSel = document.getElementById("corrVendorSelect");
    const matchEntry = SHORT_VENDOR_CATALOG.find((x) => x.id.toLowerCase() === sp.shortVendor.toLowerCase());
    vSel.value = matchEntry ? matchEntry.id : "Other";
    document.getElementById("corrModelInput").value = sp.shortModel;
    if (tierOpt && TIER_ORDER.includes(tierOpt)) {
      state.corrTier = tierOpt;
      document.querySelectorAll("#corrTierGroup .tier-pick-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.tier === state.corrTier);
      });
    }
    renderVendorPresetChips();
    syncCorrectionModeLabel();
  }

  function renderHistory() {
    const strip = document.getElementById("historyStrip");
    const filteredHist = (state.history || []).filter((h) => {
      if (state.sourceFilter === "open") return h.isOpen;
      if (state.sourceFilter === "closed") return !h.isOpen;
      return true;
    });
    document.getElementById("histCount").textContent = `${filteredHist.length} 条`;

    if (!filteredHist.length) {
      strip.innerHTML = `<span style="font-size:10.5px;color:var(--muted);">暂无记录</span>`;
      return;
    }

    strip.innerHTML = filteredHist
      .map(
        (h, idx) => `
      <button type="button" class="quick-chip" data-idx="${idx}">
        ${getVendorLogoSvg(h.vendor || h.label, 14)}
        <span>${escapeHtml(h.label)}</span>
      </button>
    `
      )
      .join("");

    strip.querySelectorAll("[data-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = filteredHist[Number(btn.dataset.idx)];
        if (!item) return;
        state.currentCode = item.code;
        state.currentType = item.type || "SVG";
        state.currentVerdict = item.verdict;
        document.getElementById("formatChip").textContent = `历史 · ${state.currentType} ${(item.code.length / 1024).toFixed(1)}KB`;
        postPreview(item.code);
        renderPopup();
      });
    });
  }

  function renderPopup() {
    renderHistory();
    if (!state.currentVerdict) return;

    const res = state.currentVerdict;
    const calc = computeFilteredVerdict(res, state.sourceFilter);
    if (!calc) return;

    const { rawList, filtered, poolSum, openSharePct, closedSharePct, overallTop, activeTop, probPct, exactHit } = calc;

    document.getElementById("pctAll").textContent = `${rawList.length}`;
    document.getElementById("pctOpen").textContent = `${openSharePct}%`;
    document.getElementById("pctClosed").textContent = `${closedSharePct}%`;

    const rarity = activeTop.rarity || "normal";
    const rank = activeTop.arenaRank || null;
    const tierKey = TIER_ORDER.includes(res.effortTier) ? res.effortTier : "high";
    const tierStr = TIER_SHORT[tierKey] || tierKey.toUpperCase();

    const card = document.getElementById("verdictCard");
    card.className = `verdict-card rarity-${rarity}`;
    document.getElementById("heroLogo").innerHTML = getVendorLogoSvg(activeTop.vendor || activeTop.label, 24);
    document.getElementById("heroTitle").textContent = activeTop.label;
    document.getElementById("confPct").textContent = `${probPct}%`;

    const badges = [];
    if (rarity === "gold") badges.push(`<span class="tag gold">🥇 #${rank || 1}</span>`);
    else if (rarity === "silver") badges.push(`<span class="tag silver">🥈 #${rank || 4}</span>`);
    badges.push(`<span class="tag ${activeTop.isOpen ? "open" : "closed"}">${activeTop.isOpen ? "开源" : "闭源"}</span>`);
    badges.push(`<span class="tag tier">强度 ${tierStr}</span>`);
    if (res.userIngested) {
      badges.push(`<span class="tag ingested">✓ 已${res.userIngested.isCorrection ? "纠错" : "归档"}入库</span>`);
    } else if (exactHit && activeTop.id === overallTop.id) {
      badges.push(`<span class="tag ingested">馆藏命中</span>`);
    }
    document.getElementById("heroBadges").innerHTML = badges.join("");

    // Default into Correction Drawer
    const detSplit = splitToShortVendorAndModel(activeTop.vendor, activeTop.label);
    state.detectedVendor = detSplit.shortVendor;
    state.detectedModel = detSplit.shortModel;
    state.detectedTier = tierKey;
    applyCorrectionSelection(activeTop.vendor, activeTop.label, tierKey);

    const quickCands = filtered.slice(0, 4);
    const qcWrap = document.getElementById("candidateQuickChips");
    qcWrap.innerHTML = quickCands
      .map((m, i) => `<button type="button" class="quick-chip" data-cand-idx="${i}">${escapeHtml(m.label)}</button>`)
      .join("");
    qcWrap.querySelectorAll("[data-cand-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const chosen = quickCands[Number(btn.dataset.candIdx)];
        if (chosen) applyCorrectionSelection(chosen.vendor, chosen.label, state.corrTier);
      });
    });

    // Details Drawer: Tiers + Top-5
    const tierMap = {};
    (res.tierProbabilities || []).forEach((tp) => { tierMap[tp.tier] = tp.probability; });
    const effConf = res.effortConfidence ?? tierMap[tierKey] ?? 0;
    document.getElementById("effortSummaryLbl").textContent = `${tierStr} (${Math.round(effConf * 100)}%)`;

    document.getElementById("tierGrid").innerHTML = TIER_ORDER.map((t) => {
      const p = (tierMap[t] || 0) * 100;
      return `<div class="tier-mini-cell ${t === tierKey ? "active" : ""}">${TIER_SHORT[t]} ${p.toFixed(0)}%</div>`;
    }).join("");

    document.getElementById("candTitle").textContent =
      state.sourceFilter === "open" ? "开源候选 Top-5" : state.sourceFilter === "closed" ? "闭源候选 Top-5" : "全库候选 Top-5";

    const top5 = filtered.slice(0, 5);
    document.getElementById("candBars").innerHTML = top5
      .map((m, idx) => {
        const normP =
          state.sourceFilter === "all"
            ? (Number(m.probability) || 0) * 100
            : poolSum > 0.0005
            ? ((Number(m.probability) || 0) / poolSum) * 100
            : 0;
        const pct = Math.min(100, Math.max(0, normP));
        const fillCol = m.isOpen ? "#2b7a61" : "#4f6d8a";
        return `<div class="cand-row" data-pick-top="${idx}" title="点击带入纠错栏">
          ${getVendorLogoSvg(m.vendor || m.label, 17)}
          <div>
            <div class="cand-name">${escapeHtml(m.label)}</div>
            <div class="prob-track"><div class="prob-fill" style="width:${pct.toFixed(1)}%;background:${fillCol};"></div></div>
          </div>
          <div class="cand-pct">${pct.toFixed(1)}%</div>
        </div>`;
      })
      .join("");

    document.querySelectorAll("[data-pick-top]").forEach((row) => {
      row.addEventListener("click", () => {
        const picked = top5[Number(row.dataset.pickTop)];
        if (!picked) return;
        state.correctOpen = true;
        document.getElementById("correctDrawer").classList.add("open");
        document.getElementById("btnToggleCorrect").classList.add("active");
        applyCorrectionSelection(picked.vendor, picked.label, state.corrTier);
      });
    });
  }

  async function identifyAndRender(rawCode, labelPrefix = "剪贴板") {
    const parsed = extractRenderableCode(rawCode);
    if (!parsed) return false;

    state.currentCode = parsed.code;
    state.currentType = parsed.type;
    document.getElementById("formatChip").textContent = `${labelPrefix} · ${parsed.type} ${(parsed.code.length / 1024).toFixed(1)}KB`;
    document.getElementById("heroTitle").textContent = "正在识别模型...";
    postPreview(parsed.code);

    const res = await chrome.runtime.sendMessage({
      type: "IDENTIFY_CODE",
      code: parsed.code,
      autoTriggered: false
    });

    if (res && res.ok && res.verdict) {
      state.currentVerdict = res.verdict;
      const st = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      if (st && st.history) state.history = st.history;
      renderPopup();
      return true;
    } else {
      document.getElementById("heroTitle").textContent = "识别请求异常";
      document.getElementById("heroBadges").innerHTML = `<span class="tag closed">${escapeHtml((res && res.error) || "请检查网络或配置")}</span>`;
      return false;
    }
  }

  async function init() {
    const vSel = document.getElementById("corrVendorSelect");
    vSel.innerHTML = SHORT_VENDOR_CATALOG.map(
      (v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.id)}</option>`
    ).join("");

    document.getElementById("popupPreviewFrame").src = "sandbox-preview.html?cid=popup";

    const st = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (st && st.config) {
      state.sourceFilter = st.config.sourceFilter || "all";
      document.getElementById("cfgApiBase").value = st.config.apiBase || DEFAULT_API_BASE;
      document.getElementById("cfgApiKey").value = st.config.apiKey || DEFAULT_API_KEY;
      document.getElementById("cfgAutoPopup").checked = st.config.autoPopup !== false;
    }
    if (st && Array.isArray(st.history)) {
      state.history = st.history;
    }
    syncPillUI();

    let foundClipboardCode = false;
    const clipTxt = await readLatestClipboardText();
    if (clipTxt && extractRenderableCode(clipTxt)) {
      foundClipboardCode = await identifyAndRender(clipTxt, "最新");
    }

    if (!foundClipboardCode && st && st.latest && st.latest.verdict) {
      state.currentCode = st.latest.code;
      state.currentType = st.latest.type || "SVG";
      state.currentVerdict = st.latest.verdict;
      document.getElementById("formatChip").textContent = `上次 · ${state.currentType}`;
      postPreview(state.currentCode);
      renderPopup();
    } else if (!foundClipboardCode) {
      renderHistory();
    }

    // Refresh Clipboard
    document.getElementById("btnRefreshPopupClip").addEventListener("click", async () => {
      const freshTxt = await readLatestClipboardText();
      if (freshTxt && extractRenderableCode(freshTxt)) {
        await identifyAndRender(freshTxt, "最新");
      } else if (state.currentCode) {
        postPreview(state.currentCode);
      }
    });

    // Source Filter Pills
    document.querySelectorAll(".source-pill-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.filter;
        state.sourceFilter = state.sourceFilter === target && target !== "all" ? "all" : target;
        syncPillUI();
        renderPopup();
        chrome.runtime.sendMessage({
          type: "SAVE_CONFIG",
          patch: { sourceFilter: state.sourceFilter }
        });
      });
    });

    // Toggle Correction & Details Drawers
    const btnCorrect = document.getElementById("btnToggleCorrect");
    btnCorrect.addEventListener("click", () => {
      state.correctOpen = !state.correctOpen;
      document.getElementById("correctDrawer").classList.toggle("open", state.correctOpen);
      btnCorrect.classList.toggle("active", state.correctOpen);
    });

    const btnDetails = document.getElementById("btnToggleDetails");
    btnDetails.addEventListener("click", () => {
      state.detailsOpen = !state.detailsOpen;
      document.getElementById("detailsDrawer").classList.toggle("open", state.detailsOpen);
      btnDetails.classList.toggle("active", state.detailsOpen);
      btnDetails.textContent = state.detailsOpen ? "收起 ▴" : "详情 ▾";
    });

    // Correction Form Controls
    vSel.addEventListener("change", () => {
      const models = getModelsForVendor(vSel.value, state.currentVerdict?.allModels);
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
        state.corrTier = btn.dataset.tier;
        document.querySelectorAll("#corrTierGroup .tier-pick-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.tier === state.corrTier);
        });
        syncCorrectionModeLabel();
      });
    });

    // Submit Correction / Archive
    document.getElementById("btnSubmitIngest").addEventListener("click", async () => {
      if (state.submitting || !state.currentCode) {
        if (!state.currentCode) showInlineToast("当前没有可入库的 SVG / HTML 源码", true);
        return;
      }
      const vendor = vSel.value.trim();
      const model = document.getElementById("corrModelInput").value.trim();
      const tier = state.corrTier || "high";
      if (!model) {
        showInlineToast("请输入或点选正确的模型型号", true);
        return;
      }

      const isCorrection =
        vendor.toLowerCase() !== state.detectedVendor.toLowerCase() ||
        model.toLowerCase() !== state.detectedModel.toLowerCase() ||
        tier !== state.detectedTier;

      const submitBtn = document.getElementById("btnSubmitIngest");
      state.submitting = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "入库中...";

      try {
        const res = await chrome.runtime.sendMessage({
          type: "SUBMIT_SAMPLE",
          code: state.currentCode,
          codeType: state.currentType,
          vendor,
          model,
          tier,
          isCorrection,
          baseVerdict: state.currentVerdict
        });

        if (res && res.ok) {
          if (res.verdict) {
            state.currentVerdict = res.verdict;
            const latestSt = await chrome.runtime.sendMessage({ type: "GET_STATE" });
            if (latestSt && latestSt.history) state.history = latestSt.history;
            renderPopup();
          }
          state.correctOpen = false;
          document.getElementById("correctDrawer").classList.remove("open");
          btnCorrect.classList.remove("active");
          showInlineToast(
            `✓ 已${isCorrection ? "纠错" : "归档"}入库：${res.displayModel} (${tier.toUpperCase()})`
          );
        } else {
          showInlineToast((res && res.error) || "入库失败，请检查密码或网络", true);
        }
      } catch (err) {
        showInlineToast(`入库异常：${err.message || err}`, true);
      } finally {
        state.submitting = false;
        submitBtn.disabled = false;
        syncCorrectionModeLabel();
      }
    });

    // Paste & Settings Drawers
    const pasteDrawer = document.getElementById("pasteDrawer");
    const settingsDrawer = document.getElementById("settingsDrawer");
    document.getElementById("btnTogglePaste").addEventListener("click", () => {
      settingsDrawer.classList.remove("open");
      pasteDrawer.classList.toggle("open");
    });
    document.getElementById("btnToggleSettings").addEventListener("click", () => {
      pasteDrawer.classList.remove("open");
      settingsDrawer.classList.toggle("open");
    });

    document.getElementById("btnReadClipNow").addEventListener("click", async () => {
      const txt = await readLatestClipboardText();
      document.getElementById("manualCodeInput").value = txt;
      if (await identifyAndRender(txt, "最新")) {
        pasteDrawer.classList.remove("open");
      }
    });

    document.getElementById("btnRunManualIdentify").addEventListener("click", async () => {
      const txt = document.getElementById("manualCodeInput").value;
      if (await identifyAndRender(txt, "粘贴")) {
        pasteDrawer.classList.remove("open");
      }
    });

    document.getElementById("btnResetCfg").addEventListener("click", async () => {
      document.getElementById("cfgApiBase").value = DEFAULT_API_BASE;
      document.getElementById("cfgApiKey").value = DEFAULT_API_KEY;
      document.getElementById("cfgAutoPopup").checked = true;
      await chrome.runtime.sendMessage({
        type: "SAVE_CONFIG",
        patch: { apiBase: DEFAULT_API_BASE, apiKey: DEFAULT_API_KEY, autoPopup: true }
      });
      settingsDrawer.classList.remove("open");
      showInlineToast("已恢复默认服务地址与密码");
    });

    document.getElementById("btnSaveCfg").addEventListener("click", async () => {
      await chrome.runtime.sendMessage({
        type: "SAVE_CONFIG",
        patch: {
          apiBase: document.getElementById("cfgApiBase").value.trim() || DEFAULT_API_BASE,
          apiKey: document.getElementById("cfgApiKey").value.trim() || DEFAULT_API_KEY,
          autoPopup: document.getElementById("cfgAutoPopup").checked
        }
      });
      settingsDrawer.classList.remove("open");
      showInlineToast("✓ 配置已保存");
    });

    document.getElementById("btnSendToPage").addEventListener("click", async () => {
      if (!state.currentCode) return;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: "SHOW_PELICAN_FLOATING_PREVIEW",
          code: state.currentCode,
          codeType: state.currentType
        }).catch(() => {});
        window.close();
      }
    });
  }

  init();
})();
