(function (root) {
  "use strict";

  function errorText(error, fallback) {
    return typeof error === "string" ? error
      : typeof error?.message === "string" ? error.message : fallback;
  }

  function createChatController({ document, fetch, consumeSse, renderMarkdown }) {
    const input = document.getElementById("prompt-input");
    const button = document.getElementById("btn-send");
    const messages = document.getElementById("messages-container");
    const mode = document.getElementById("model-select");
    let active = null;

    function updateButton() {
      button.textContent = active ? "■" : "➤";
      button.style.background = active ? "var(--accent-red)" : "var(--accent)";
      button.disabled = Boolean(active?.signal.aborted);
      const label = active?.signal.aborted ? "Stopping" : active ? "Stop" : "Send";
      button.title = label;
      button.setAttribute("aria-label", label);
    }

    function cancel() {
      active?.abort();
      updateButton();
    }

    async function send() {
      const prompt = input.value.trim();
      if (!prompt || active) return;
      const controller = new AbortController();
      active = controller;
      updateButton();
      input.value = "";
      input.style.height = "auto";

      const user = document.createElement("div");
      user.className = "message user";
      user.textContent = prompt;
      messages.appendChild(user);
      const bot = document.createElement("div");
      bot.className = "message assistant";
      const answer = document.createElement("div");
      const status = document.createElement("div");
      status.setAttribute("role", "status");
      status.textContent = "Preparing…";
      bot.appendChild(answer);
      bot.appendChild(status);
      messages.appendChild(bot);
      messages.scrollTop = messages.scrollHeight;
      let content = "";
      let goalStatus;

      // Rendering the full markdown on every delta is quadratic in stream
      // length; coalesce renders into one per animation frame (synchronous
      // when requestAnimationFrame is unavailable, e.g. tests).
      let lastRenderedContent = null;
      let renderScheduled = false;
      const renderAnswer = () => {
        if (content === lastRenderedContent) return;
        lastRenderedContent = content;
        // renderMarkdown escapes agent text before adding formatting.
        answer.innerHTML = renderMarkdown(content);
      };
      const scheduleRender = () => {
        if (renderScheduled) return;
        renderScheduled = true;
        const run = () => {
          renderScheduled = false;
          if (!active) return;
          renderAnswer();
          status.textContent = "Running…";
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
        else run();
      };

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: mode.value, prompt }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(errorText(payload.error, `HTTP ${response.status}`));
        }
        await consumeSse(response, (event) => {
          if (event.event?.error || event.metadata?.error) {
            throw new Error(errorText(event.event?.error || event.metadata?.message, "Execution failed"));
          }
          if (event.delta) {
            content += event.delta;
            scheduleRender();
          }
          if (event.metadata?.goal) goalStatus = event.metadata.goal.status;
        });
        if (controller.signal.aborted) {
          status.textContent = "Stopped. Check Git diff for changes.";
        } else {
          status.textContent = goalStatus === "blocked" ? "Input needed."
            : goalStatus === "budget_exhausted" ? "Round limit reached. Use the command in the response to continue."
            : "Complete";
        }
      } catch (error) {
        // Preserve all partial output; error strings are never interpreted as HTML.
        status.textContent = controller.signal.aborted || error?.name === "AbortError"
          ? "Stopped. Check Git diff for changes."
          : `Error: ${errorText(error, "Network error")}`;
      } finally {
        // A scheduled frame may fire after this request finished (run() guards
        // on `active`), so render the final partial content synchronously here.
        renderAnswer();
        active = null;
        updateButton();
      }
    }

    button.addEventListener("click", () => active ? cancel() : send());
    updateButton();
    return { send, cancel, get busy() { return Boolean(active); } };
  }

  root.OpenCursorMobileChat = { createChatController };
})(globalThis);
