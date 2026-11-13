(function () {
  "use strict";

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== "offscreen") return false;

    if (msg.type === "OFFSCREEN_PING") {
      sendResponse({ ok: true, ready: true });
      return false;
    }

    if (msg.type !== "OFFSCREEN_READ_CLIPBOARD") return false;

    (async () => {
      try {
        const area = document.getElementById("pasteTarget");
        if (area) {
          area.value = "";
          area.focus({ preventScroll: true });
          area.select();
          const ok = document.execCommand("paste");
          const pasted = area.value;
          area.value = "";
          if (ok && typeof pasted === "string" && pasted.length > 0) {
            sendResponse({ ok: true, text: pasted, via: "execCommand" });
            return;
          }
        }
      } catch (_) {}

      try {
        if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
          const text = await navigator.clipboard.readText();
          sendResponse({ ok: true, text: text || "", via: "readText" });
          return;
        }
      } catch (err) {
        sendResponse({ ok: false, text: "", error: String(err) });
        return;
      }

      sendResponse({ ok: true, text: "" });
    })();

    return true;
  });
})();
