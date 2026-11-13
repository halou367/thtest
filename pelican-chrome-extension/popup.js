(function () {
  "use strict";

  const {
    DEFAULT_API_BASE,
    DEFAULT_API_KEY,
    TIER_ORDER,
    TIER_CN,
    escapeHtml,
    extractRenderableCode,
    getVendorLogoSvg,
    computeFilteredVerdict
  } = window.PelicanShared;

  let renderSeq = 0;
  let ackedRenderId = "";
  let retryTimer = null;

  const state = {
    sourceFilter: "all",
    currentCode: "",
    currentType: "SVG",
    currentVerdict: null,
    history: []
  };

  // Register ACK listener BEFORE setting iframe.src!
  window.addEventListener("message", (ev) => {
    const d = ev && ev.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "PELICAN_RENDER_ACK" && d.cid === "popup" && d.renderId) {
      ackedRenderId = d.renderId;
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
    }
  });

  function postPreview(code) {
    const frame = document.getElementById("popupPreviewFrame");
    if (!frame) return;

    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }

    const renderId = `popup_${++renderSeq}`;
    let attempts = 0;

    const tryPost = () => {
      attempts++;
      if (ackedRenderId === renderId || attempts > 35) {
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
    retryTimer = setInterval(tryPost, 50);
  }

  // Read live clipboard reliably via background offscreen document first, then popup readText fallback
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

  function renderPopup() {
    renderHistory();
    if (!state.currentVerdict) return;

    const res = state.currentVerdict;
    const calc = computeFilteredVerdict(res, state.sourceFilter);
    if (!calc) return;

    const { rawList, filtered, poolSum, openSharePct, closedSharePct, overallTop, activeTop, displayProb, probPct, exactHit } = calc;

    document.getElementById("pctAll").textContent = `${rawList.length}款`;
    document.getElementById("pctOpen").textContent = `${openSharePct}%`;
    document.getElementById("pctClosed").textContent = `${closedSharePct}%`;

    const rarity = activeTop.rarity || "normal";
    const rank = activeTop.arenaRank || null;
    const tierStr = (res.effortTier || "high").toUpperCase();

    const notice = document.getElementById("filterNotice");
    if (state.sourceFilter !== "all" && overallTop.isOpen !== (state.sourceFilter === "open") && (overallTop.probability || 0) >= 0.85) {
      const oppName = overallTop.isOpen ? "开源" : "闭源";
      notice.style.display = "block";
      notice.textContent = `提示：全库高把握命中${oppName}模型 ${overallTop.label} (${Math.round(overallTop.probability * 100)}%)，当前已强制筛选${state.sourceFilter === "open" ? "开源" : "闭源"}池候选。`;
    } else {
      notice.style.display = "none";
    }

    // 1. Annotation Overlay
    const annotBar = document.getElementById("annotBar");
    annotBar.style.display = "flex";
    annotBar.className = `preview-model-annot annot-${rarity}`;
    document.getElementById("annotLogo").innerHTML = getVendorLogoSvg(activeTop.vendor || activeTop.label, 19);
    document.getElementById("annotName").textContent = activeTop.label;
    const annotSrc = document.getElementById("annotSrc");
    annotSrc.className = `micro-badge ${activeTop.isOpen ? "open" : "closed"}`;
    annotSrc.textContent = activeTop.isOpen ? "开源" : "闭源";
    document.getElementById("annotTier").textContent = tierStr;
    document.getElementById("annotConf").textContent = `${probPct}%`;

    // 2. Hero Card
    const hero = document.getElementById("verdictHero");
    hero.className = "gacha-hero";
    void hero.offsetWidth;
    hero.classList.add(`rarity-${rarity}`);

    const rarityPill = document.getElementById("rarityPill");
    const heroSub = document.getElementById("heroSub");
    if (rarity === "gold") {
      rarityPill.textContent = `🥇 金色传说 · ARENA #${rank || 1} 主推`;
      heroSub.textContent = `榜单前三主推 · 强度 ${tierStr} · ${res.elapsedMs || 12}ms`;
    } else if (rarity === "silver") {
      rarityPill.textContent = `🥈 银色主推 · ARENA #${rank || 4} 推荐`;
      heroSub.textContent = `榜单 4–6 推荐 · 强度 ${tierStr} · ${res.elapsedMs || 12}ms`;
    } else {
      rarityPill.textContent = state.sourceFilter === "open" ? "开源模型池 · 首位命中" : state.sourceFilter === "closed" ? "闭源商业池 · 首位命中" : "常规模型池 · 细分归属";
      heroSub.textContent = `推理强度 ${tierStr} · 原始得分 ${((activeTop.probability || 0) * 100).toFixed(1)}%`;
    }

    const heroSrcTag = document.getElementById("heroSrcTag");
    heroSrcTag.style.display = "inline-block";
    heroSrcTag.className = `micro-badge ${activeTop.isOpen ? "open" : "closed"}`;
    heroSrcTag.textContent = activeTop.isOpen ? "开源权重" : "闭源商业";

    const confBandTag = document.getElementById("confBandTag");
    if (exactHit && activeTop.id === overallTop.id) confBandTag.textContent = "馆藏精确命中";
    else if (displayProb >= 0.88) confBandTag.textContent = "高把握";
    else if (displayProb >= 0.55) confBandTag.textContent = "倾向判断";
    else confBandTag.textContent = "多候选竞争";

    document.getElementById("heroLogo").innerHTML = getVendorLogoSvg(activeTop.vendor || activeTop.label, 26);
    document.getElementById("heroTitle").textContent = activeTop.label;

    const circum = 138.2;
    const offset = circum * (1 - Math.max(0.03, Math.min(1, displayProb)));
    const ring = document.getElementById("confRing");
    ring.style.strokeDashoffset = offset.toFixed(1);
    ring.setAttribute(
      "stroke",
      rarity === "gold" ? "#c49545" : rarity === "silver" ? "#6d849c" : activeTop.isOpen ? "#276e59" : "#4f6d8a"
    );
    document.getElementById("confPct").textContent = `${probPct}%`;

    // 3. Effort Tier Grid
    const tierMap = {};
    (res.tierProbabilities || []).forEach((tp) => { tierMap[tp.tier] = tp.probability; });
    const effConf = res.effortConfidence ?? tierMap[res.effortTier] ?? 0;
    document.getElementById("effortHeadline").textContent =
      `${TIER_CN[res.effortTier] || tierStr} (${Math.round(effConf * 100)}%)`;

    document.getElementById("tierGrid").innerHTML = TIER_ORDER.map((t) => {
      const p = (tierMap[t] || 0) * 100;
      const isTop = t === res.effortTier;
      return `<div class="tier-seg ${isTop ? "active" : ""}">
        <div class="tier-seg-label">${t}</div>
        <div class="tier-seg-val">${p.toFixed(0)}%</div>
      </div>`;
    }).join("");

    // 4. Top-5 Filtered Candidates
    document.getElementById("candTitle").textContent =
      state.sourceFilter === "open" ? "开源模型概率分布" : state.sourceFilter === "closed" ? "闭源模型概率分布" : "全库模型概率分布";
    document.getElementById("candHint").textContent =
      state.sourceFilter === "all" ? "Top-5 候选" : `池内归一化 · 共 ${filtered.length} 款`;

    document.getElementById("candBars").innerHTML = filtered.slice(0, 5).map((m) => {
      const normP = state.sourceFilter === "all"
        ? (Number(m.probability) || 0) * 100
        : poolSum > 0.0005 ? ((Number(m.probability) || 0) / poolSum) * 100 : 0;
      const pct = Math.min(100, Math.max(0, normP));
      const r = m.rarity || "normal";
      const barColor =
        r === "gold" ? "linear-gradient(90deg, #cda052, #b48332)"
        : r === "silver" ? "linear-gradient(90deg, #879cb2, #637991)"
        : m.isOpen ? "linear-gradient(90deg, #348f73, #236852)" : "#6d8094";
      const rankTag =
        r === "gold" ? `<span class="mini-rank-tag gold">#${m.arenaRank} 金</span>`
        : r === "silver" ? `<span class="mini-rank-tag silver">#${m.arenaRank} 银</span>` : "";
      const srcTag = `<span class="mini-rank-tag ${m.isOpen ? "open" : "closed"}">${m.isOpen ? "开源" : "闭源"}</span>`;

      return `<div class="cand-row">
        ${getVendorLogoSvg(m.vendor || m.label, 19)}
        <div>
          <div class="cand-name-line"><span>${escapeHtml(m.label)}</span>${rankTag}${srcTag}</div>
          <div class="prob-track"><div class="prob-fill" style="width:${pct.toFixed(1)}%;background:${barColor};"></div></div>
        </div>
        <div class="cand-pct">${pct.toFixed(1)}%</div>
      </div>`;
    }).join("");
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
      strip.innerHTML = `<span style="font-size:11px;color:var(--muted);">当前过滤条件下暂无记录</span>`;
      return;
    }

    strip.innerHTML = filteredHist.map((h, idx) => `
      <button type="button" class="hist-chip" data-idx="${idx}">
        ${getVendorLogoSvg(h.vendor || h.label, 15)}
        <span>${escapeHtml(h.label)}</span>
        <span class="mini-rank-tag ${h.isOpen ? "open" : "closed"}">${h.isOpen ? "开" : "闭"}</span>
      </button>
    `).join("");

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

  async function identifyAndRender(rawCode, labelPrefix = "实时") {
    const parsed = extractRenderableCode(rawCode);
    if (!parsed) return false;

    state.currentCode = parsed.code;
    state.currentType = parsed.type;
    document.getElementById("formatChip").textContent = `${labelPrefix} · ${parsed.type} ${(parsed.code.length / 1024).toFixed(1)}KB`;
    document.getElementById("heroTitle").textContent = "正在识别型号...";
    document.getElementById("heroSub").textContent = "正在请求 th.629717.cc.cd...";
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
      document.getElementById("heroSub").textContent = (res && res.error) || "请检查网络或配置";
      return false;
    }
  }

  async function init() {
    // Boot sandbox iframe AFTER listener is registered
    document.getElementById("popupPreviewFrame").src = "sandbox-preview.html";

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

    // Always read live system clipboard via background offscreen reader FIRST!
    let foundClipboardCode = false;
    const clipTxt = await readLatestClipboardText();
    if (clipTxt && extractRenderableCode(clipTxt)) {
      foundClipboardCode = await identifyAndRender(clipTxt, "最新剪贴板");
    }

    // Only if current clipboard is plain non-code text, show last recorded item clearly labeled "上次记录"
    if (!foundClipboardCode && st && st.latest && st.latest.verdict) {
      state.currentCode = st.latest.code;
      state.currentType = st.latest.type || "SVG";
      state.currentVerdict = st.latest.verdict;
      document.getElementById("formatChip").textContent = `上次记录 · ${state.currentType}`;
      postPreview(state.currentCode);
      renderPopup();
    } else if (!foundClipboardCode) {
      renderHistory();
    }

    // Force Refresh Clipboard Button
    document.getElementById("btnRefreshPopupClip").addEventListener("click", async () => {
      const freshTxt = await readLatestClipboardText();
      if (freshTxt && extractRenderableCode(freshTxt)) {
        await identifyAndRender(freshTxt, "最新剪贴板");
      } else if (state.currentCode) {
        postPreview(state.currentCode);
      }
    });

    // Bind Open/Closed Pills
    document.querySelectorAll(".source-pill-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.filter;
        state.sourceFilter = (state.sourceFilter === target && target !== "all") ? "all" : target;
        syncPillUI();
        renderPopup();
        chrome.runtime.sendMessage({
          type: "SAVE_CONFIG",
          patch: { sourceFilter: state.sourceFilter }
        });
      });
    });

    // Drawers
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
      if (await identifyAndRender(txt, "最新剪贴板")) {
        pasteDrawer.classList.remove("open");
      }
    });

    document.getElementById("btnRunManualIdentify").addEventListener("click", async () => {
      const txt = document.getElementById("manualCodeInput").value;
      if (await identifyAndRender(txt, "手动粘贴")) {
        pasteDrawer.classList.remove("open");
      }
    });

    // Save / Reset Settings
    document.getElementById("btnResetCfg").addEventListener("click", async () => {
      document.getElementById("cfgApiBase").value = DEFAULT_API_BASE;
      document.getElementById("cfgApiKey").value = DEFAULT_API_KEY;
      document.getElementById("cfgAutoPopup").checked = true;
      await chrome.runtime.sendMessage({
        type: "SAVE_CONFIG",
        patch: { apiBase: DEFAULT_API_BASE, apiKey: DEFAULT_API_KEY, autoPopup: true }
      });
      settingsDrawer.classList.remove("open");
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
    });

    // Send to active webpage floating window
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
