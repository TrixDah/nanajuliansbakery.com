(() => {
  "use strict";
  const MESSAGE_KEY = "nana-bread-battle-local-messages-v1";
  const el = id => document.getElementById(id);

  function loadMessages() {
    try {
      const messages = JSON.parse(localStorage.getItem(MESSAGE_KEY) || "[]");
      return Array.isArray(messages)
        ? messages.filter(m => m && typeof m.text === "string" && typeof m.name === "string").slice(0, 50)
        : [];
    } catch { return []; }
  }

  function renderMessageBoard() {
    const list = el("message-list"), empty = el("message-board-empty");
    if (!list || !empty) return;
    list.replaceChildren();
    const messages = loadMessages();
    empty.hidden = messages.length > 0;
    for (const post of messages) {
      const item = document.createElement("li");
      const meta = document.createElement("div"); meta.className = "message-meta";
      const author = document.createElement("strong"); author.textContent = post.name;
      const date = document.createElement("time");
      const stamp = new Date(Number(post.createdAt) || Date.now());
      date.dateTime = stamp.toISOString(); date.textContent = stamp.toLocaleString();
      const body = document.createElement("p"); body.className = "message-text"; body.textContent = post.text;
      meta.append(author, date); item.append(meta, body); list.appendChild(item);
    }
  }

  el("message-form")?.addEventListener("submit", event => {
    event.preventDefault();
    const nameInput = el("message-name"), bodyInput = el("message-body"), feedback = el("message-feedback");
    const text = bodyInput.value.trim();
    if (!text) { if (feedback) feedback.textContent = "Please write a message before pinning it."; return; }
    const name = nameInput.value.trim().slice(0, 32) || "Anonymous Baker";
    const messages = loadMessages();
    messages.unshift({ name, text: text.slice(0, 280), createdAt: Date.now() });
    try {
      localStorage.setItem(MESSAGE_KEY, JSON.stringify(messages.slice(0, 50)));
      bodyInput.value = "";
      if (feedback) feedback.textContent = "Your message is pinned in this browser.";
      renderMessageBoard();
    } catch {
      if (feedback) feedback.textContent = "This browser could not save the message. Check local storage settings.";
    }
  });

  renderMessageBoard();
})();
