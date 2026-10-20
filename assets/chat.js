(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const el = {
    authSection: $("auth-section"), loginForm: $("login-form"), verifyForm: $("verify-form"), codePrompt: $("code-prompt"),
    email: $("login-email"), code: $("login-code"), authFeedback: $("auth-feedback"), keySetup: $("key-setup"), keyRecovery: $("key-recovery"),
    recoveryCodeDisplay: $("recovery-code-display"), copyRecoveryCode: $("copy-recovery-code"), downloadFirstBackup: $("download-first-backup"),
    recoverySaved: $("recovery-saved"), finishKeySetup: $("finish-key-setup"), recoveryForm: $("recovery-form"), recoveryFile: $("recovery-file"),
    recoveryCodeInput: $("recovery-code-input"), restoreKeys: $("restore-keys"), chatApp: $("chat-app"), signedInName: $("signed-in-name"),
    signedInEmail: $("signed-in-email"), profileForm: $("profile-form"), profileName: $("profile-name"),
    downloadBackup: $("download-backup"), logout: $("logout"), appStatus: $("app-status"),
    roomList: $("room-list"), newGroupToggle: $("new-group-toggle"), groupForm: $("group-form"), groupName: $("group-name"),
    groupMemberOptions: $("group-member-options"), cancelGroup: $("cancel-group"), dmPerson: $("dm-person"), openDm: $("open-dm"),
    keyFingerprints: $("key-fingerprints"),
    roomTitle: $("room-title"), roomSubtitle: $("room-subtitle"), messages: $("chat-messages"), sendForm: $("send-form"),
    messageInput: $("message-input"), messageCount: $("message-count"), sendMessage: $("send-message"), loadOlder: $("load-older"),
    historyStatus: $("history-status"), changeEmail: $("change-email"), requestCode: $("request-code"), verifyCode: $("verify-code")
  };
  const state = {
    me: null, identity: null, pendingIdentity: null, backupDownloaded: false, roomList: [], directory: [], directoryMap: new Map(),
    trust: new Map(), trustFailures: new Map(), activeRoom: null, latest: null, oldest: null,
    renderedIds: new Set(), polling: null, directoryRefreshTimer: null, pollingBusy: false, pollFailureShown: false, sendBusy: false, roomsLoading: false
  };
  const MAX_TEXT = 4000;
  const POLL_MS = 5000;

  class ClientError extends Error {
    constructor(message, status = 0, retryAfter = 0, code = "") { super(message); this.status = status; this.retryAfter = retryAfter; this.code = code; }
  }
  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json");
    let response;
    try {
      response = await fetch(path, { ...options, headers, credentials: "same-origin", cache: "no-store" });
    } catch {
      throw new ClientError("The chat server could not be reached. Check the connection and that the Node chat backend is running.");
    }
    let payload = null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try { payload = await response.json(); } catch { payload = null; }
    }
    if (!response.ok) {
      const nonJsonHint = !contentType.includes("application/json") && (response.status === 404 || response.status === 405)
        ? " This website is not connected to the chat API yet; GitHub Pages by itself cannot run the chat server."
        : "";
      throw new ClientError(`${payload?.error || `Request failed (${response.status}).`}${nonJsonHint}`, response.status,
        Number(response.headers.get("retry-after") || payload?.retryAfter || 0), payload?.code || "");
    }
    if (!contentType.includes("application/json") || !payload) throw new ClientError("The chat API returned an unexpected response.", response.status);
    return payload;
  }
  function showFeedback(node, message, kind = "") {
    if (!node) return;
    node.textContent = message || "";
    if (kind) node.dataset.kind = kind; else delete node.dataset.kind;
  }
  function showAppStatus(message, kind = "") { showFeedback(el.appStatus, message, kind); }
  function readableError(error) {
    let message = error?.message || "Something went wrong.";
    if (error?.status === 429 && error.retryAfter) message += ` Retry in about ${error.retryAfter} seconds.`;
    if (error?.code === "RECIPIENT_LIST_CHANGED") message += " Refresh the room and send again.";
    return message;
  }
  function setButtonBusy(button, busy, busyText, normalText) {
    if (!button) return;
    if (busy) { button.dataset.normalText = normalText || button.textContent; button.disabled = true; if (busyText) button.textContent = busyText; }
    else { button.disabled = false; if (button.dataset.normalText) button.textContent = button.dataset.normalText; }
  }
  function showAuthPanel(panel) {
    el.loginForm.hidden = panel !== "login";
    el.verifyForm.hidden = panel !== "verify";
    el.keySetup.hidden = panel !== "setup";
    el.keyRecovery.hidden = panel !== "recovery";
    el.authSection.hidden = panel === "chat";
    el.chatApp.hidden = panel !== "chat";
  }
  function activeAuthEmail() { return state.me?.email || el.email.value.trim().toLowerCase(); }

  async function requestLoginCode(event) {
    event?.preventDefault();
    const email = el.email.value.trim().toLowerCase();
    if (!email) return showFeedback(el.authFeedback, "Enter your email address first.", "error");
    setButtonBusy(el.requestCode, true, "Sending…", "Email me a code");
    showFeedback(el.authFeedback, "Requesting a one-time sign-in code…");
    try {
      const result = await api("/api/auth/request-code", { method: "POST", body: JSON.stringify({ email }) });
      el.email.value = email;
      el.codePrompt.textContent = `${result.message || "Check your inbox for the one-time code."} Address: ${email}`;
      showAuthPanel("verify");
      showFeedback(el.authFeedback, result.message || "Check your inbox for the code.", "success");
      el.code.focus();
    } catch (error) { showFeedback(el.authFeedback, readableError(error), "error"); }
    finally { setButtonBusy(el.requestCode, false); }
  }

  async function verifyLoginCode(event) {
    event?.preventDefault();
    const email = el.email.value.trim().toLowerCase();
    const code = el.code.value.trim();
    if (!/^\d{6}$/.test(code)) return showFeedback(el.authFeedback, "Enter the six-digit code from your email.", "error");
    setButtonBusy(el.verifyCode, true, "Checking…", "Verify & sign in");
    showFeedback(el.authFeedback, "Verifying code…");
    try {
      const result = await api("/api/auth/verify-code", { method: "POST", body: JSON.stringify({ email, code }) });
      el.code.value = "";
      await handleSignedIn(result.user);
    } catch (error) { showFeedback(el.authFeedback, readableError(error), "error"); }
    finally { setButtonBusy(el.verifyCode, false); }
  }

  async function bootstrap() {
    showAuthPanel("login");
    try {
      const result = await api("/api/me");
      await handleSignedIn(result.user);
    } catch (error) {
      if (error.status === 401) {
        showAuthPanel("login");
        showFeedback(el.authFeedback, "Sign in with an email code to join the village chat.");
      } else {
        showAuthPanel("login");
        showFeedback(el.authFeedback, readableError(error), "error");
      }
    }
  }

  async function handleSignedIn(user) {
    if (!user?.id || !user?.email) throw new ClientError("The sign-in response did not include an account.");
    state.me = user;
    showAuthPanel("login");
    showFeedback(el.authFeedback, "Checking your local encryption keys. Private keys are never uploaded.");
    try {
      const stored = await NanaChatCrypto.getIdentity(user.id);
      if (stored) {
        state.identity = stored;
        if (user.encryptionKey && user.signingKey) {
          if (stored.encryptionKey !== user.encryptionKey || stored.signingKey !== user.signingKey) {
            state.pendingIdentity = null;
            showAuthPanel("recovery");
            showFeedback(el.authFeedback, "The local keys do not match this account's registered keys. Restore using the matching recovery file; this page will not replace the server keys.", "error");
            return;
          }
          await enterChat();
          return;
        }
        await registerLocalKeys();
        await enterChat();
        return;
      }
      if (user.encryptionKey && user.signingKey) {
        showAuthPanel("recovery");
        showFeedback(el.authFeedback, "This account's private keys are not on this browser. Restore them with your recovery file and code.");
        return;
      }
      await prepareNewIdentity();
    } catch (error) {
      showAuthPanel(user.encryptionKey && user.signingKey ? "recovery" : "login");
      showFeedback(el.authFeedback, readableError(error), "error");
    }
  }

  async function prepareNewIdentity() {
    showAuthPanel("setup");
    el.recoveryCodeDisplay.textContent = "Generating secure keys…";
    el.recoverySaved.checked = false;
    el.finishKeySetup.disabled = true;
    state.backupDownloaded = false;
    setButtonBusy(el.downloadFirstBackup, true, "Preparing…", "Download encrypted recovery file");
    try {
      state.pendingIdentity = await NanaChatCrypto.generateNewIdentity();
      el.recoveryCodeDisplay.textContent = state.pendingIdentity.recoveryCode;
      setButtonBusy(el.downloadFirstBackup, false);
      showFeedback(el.authFeedback, "Keys generated. Download the encrypted file, store the recovery code separately, then tick the confirmation box.", "success");
    } catch (error) {
      state.pendingIdentity = null;
      showAuthPanel("login");
      showFeedback(el.authFeedback, readableError(error), "error");
    }
  }

  function maybeEnableFinish() {
    el.finishKeySetup.disabled = !(state.backupDownloaded && el.recoverySaved.checked && state.pendingIdentity);
  }
  function downloadFirstBackup() {
    if (!state.pendingIdentity?.backupText) return;
    try {
      NanaChatCrypto.downloadBackup(state.pendingIdentity.backupText);
      state.backupDownloaded = true;
      maybeEnableFinish();
      showFeedback(el.authFeedback, "Encrypted recovery file downloaded. Keep its code separately.", "success");
    } catch (error) { showFeedback(el.authFeedback, readableError(error), "error"); }
  }
  async function copyRecoveryCode() {
    const text = state.pendingIdentity?.recoveryCode;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showFeedback(el.authFeedback, "Recovery code copied. Save it somewhere separate from the recovery file.", "success");
    } catch {
      showFeedback(el.authFeedback, "Clipboard access is unavailable. Select the displayed recovery code and copy it manually.", "error");
    }
  }
  async function finishKeySetup() {
    if (!state.pendingIdentity || !state.backupDownloaded || !el.recoverySaved.checked) return;
    setButtonBusy(el.finishKeySetup, true, "Saving keys…", "Save keys on this device & continue");
    try {
      const pending = state.pendingIdentity;
      const record = {
        userId: state.me.id,
        privateEncryptionKey: pending.privateEncryptionKey,
        privateSigningKey: pending.privateSigningKey,
        encryptionKey: pending.encryptionKey,
        signingKey: pending.signingKey,
        backupText: pending.backupText,
        savedAt: Date.now()
      };
      await NanaChatCrypto.saveIdentity(record);
      state.identity = record;
      await registerLocalKeys();
      state.pendingIdentity = null;
      await enterChat();
    } catch (error) {
      showFeedback(el.authFeedback, readableError(error), "error");
    } finally { setButtonBusy(el.finishKeySetup, false); maybeEnableFinish(); }
  }

  async function registerLocalKeys() {
    if (!state.identity) throw new ClientError("Local encryption keys are missing.");
    if (state.me.encryptionKey && state.me.signingKey) {
      if (state.identity.encryptionKey !== state.me.encryptionKey || state.identity.signingKey !== state.me.signingKey) {
        throw new ClientError("Local keys do not match the account's registered keys. Restore from the correct recovery file.");
      }
      return;
    }
    const result = await api("/api/me/keys", {
      method: "PUT",
      body: JSON.stringify({ encryptionKey: state.identity.encryptionKey, signingKey: state.identity.signingKey })
    });
    state.me = result.user;
  }

  async function restoreKeys(event) {
    event.preventDefault();
    if (!state.me?.encryptionKey || !state.me?.signingKey) return showFeedback(el.authFeedback, "This account has not registered encryption keys yet. Sign out and sign in again.", "error");
    const file = el.recoveryFile.files?.[0];
    const recoveryCode = el.recoveryCodeInput.value.trim().replace(/\s+/g, "");
    if (!file || file.size > 100000) return showFeedback(el.authFeedback, "Choose a valid recovery JSON file (under 100 KB).", "error");
    if (!recoveryCode) return showFeedback(el.authFeedback, "Enter the recovery code stored separately from the file.", "error");
    setButtonBusy(el.restoreKeys, true, "Decrypting…", "Decrypt & restore keys");
    try {
      const text = await file.text();
      const identity = await NanaChatCrypto.restoreIdentity(state.me.id, text, recoveryCode, state.me.encryptionKey, state.me.signingKey);
      await NanaChatCrypto.saveIdentity({ ...identity, savedAt: Date.now() });
      state.identity = { ...identity, savedAt: Date.now() };
      el.recoveryCodeInput.value = "";
      el.recoveryFile.value = "";
      await enterChat();
    } catch (error) { showFeedback(el.authFeedback, readableError(error), "error"); }
    finally { setButtonBusy(el.restoreKeys, false); }
  }

  async function enterChat() {
    if (!state.me?.encryptionKey || !state.me?.signingKey || !state.identity?.privateEncryptionKey || !state.identity?.privateSigningKey) {
      throw new ClientError("Encryption setup is incomplete. Restore or set up keys before using chat.");
    }
    const ownPinned = await NanaChatCrypto.pinPublicIdentity(state.me);
    if (!ownPinned.ok) throw new ClientError("This account's public keys changed unexpectedly. Stop and verify the account before messaging.");
    state.trust.set(state.me.id, { ok: true, user: state.me });
    el.signedInName.textContent = state.me.displayName || "Village Baker";
    el.signedInEmail.textContent = state.me.email;
    el.profileName.value = state.me.displayName || "";
    showAuthPanel("chat");
    el.messages.replaceChildren();
    stopPolling();
    state.activeRoom = null;
    state.latest = null; state.oldest = null; state.renderedIds.clear();
    showAppStatus("Loading the village directory and rooms…");
    await refreshDirectory();
    await refreshRooms();
    const publicRoom = state.roomList.find(room => room.type === "public");
    if (publicRoom) await selectRoom(publicRoom.id);
    showAppStatus("Connected. Messages are encrypted and signed in this browser.", "success");
    state.polling = setInterval(() => { pollActiveRoom().catch(() => {}); }, POLL_MS);
    if (state.directoryRefreshTimer) clearInterval(state.directoryRefreshTimer);
    state.directoryRefreshTimer = setInterval(() => {
      if (document.hidden || !state.me) return;
      refreshDirectory().then(refreshRooms).catch(error => showAppStatus(readableError(error), "error"));
    }, 60 * 1000);
  }

  async function refreshDirectory() {
    const result = await api("/api/directory");
    state.directory = result.users.filter(user => user.id !== state.me.id);
    state.directoryMap.clear();
    state.trustFailures.clear();
    for (const user of result.users) {
      const trust = await NanaChatCrypto.pinPublicIdentity(user);
      const record = { ...trust, user };
      state.trust.set(user.id, record);
      if (!trust.ok) state.trustFailures.set(user.id, `Public keys for ${user.displayName} changed since this browser first saw them. Verify the fingerprint out of band before messaging.`);
      state.directoryMap.set(user.id, user);
    }
    const options = [];
    const prompt = document.createElement("option"); prompt.value = ""; prompt.textContent = "Choose a baker…"; options.push(prompt);
    for (const user of state.directory) {
      const option = document.createElement("option");
      option.value = user.id;
      const shortId = user.id.slice(0, 4).toUpperCase();
      option.textContent = state.trustFailures.has(user.id) ? `${user.displayName} · ${shortId} — KEY WARNING` : `${user.displayName} · ${shortId}`;
      option.disabled = state.trustFailures.has(user.id);
      options.push(option);
    }
    el.dmPerson.replaceChildren(...options);
    renderGroupMemberOptions();
    await renderFingerprints(result.users);
    if (state.trustFailures.size) {
      showAppStatus(`${state.trustFailures.size} account key change warning(s). Those users are disabled until you verify the keys out of band.`, "error");
    }
  }


  async function renderFingerprints(users) {
    el.keyFingerprints.replaceChildren();
    const allUsers = [...users].sort((a, b) => a.displayName.localeCompare(b.displayName));
    for (const user of allUsers) {
      const li = document.createElement("li");
      const name = document.createElement("strong"); name.textContent = user.id === state.me.id ? `${user.displayName} (you)` : user.displayName;
      const code = document.createElement("code");
      try { code.textContent = await NanaChatCrypto.fingerprint(user); }
      catch { code.textContent = "Fingerprint unavailable"; }
      if (state.trustFailures.has(user.id)) li.classList.add("fingerprint-warning");
      li.append(name, code); el.keyFingerprints.appendChild(li);
    }
  }

  function renderGroupMemberOptions() {
    el.groupMemberOptions.replaceChildren();
    if (!state.directory.length) {
      const empty = document.createElement("p"); empty.className = "tiny-note"; empty.textContent = "No other encrypted accounts are available yet."; el.groupMemberOptions.appendChild(empty); return;
    }
    for (const user of state.directory) {
      const label = document.createElement("label"); label.className = "member-choice";
      const check = document.createElement("input"); check.type = "checkbox"; check.name = "group-member"; check.value = user.id; check.disabled = state.trustFailures.has(user.id);
      const text = document.createElement("span"); text.textContent = `${user.displayName} · ${user.id.slice(0, 4).toUpperCase()}` + (check.disabled ? " — key warning" : "");
      label.append(check, text); el.groupMemberOptions.appendChild(label);
    }
  }

  async function refreshRooms() {
    if (state.roomsLoading) return;
    state.roomsLoading = true;
    try {
      const result = await api("/api/rooms");
      state.roomList = result.rooms;
      renderRoomList();
    } finally { state.roomsLoading = false; }
  }
  function roomDisplayName(room) {
    if (room.type === "public") return "🌾 " + room.name;
    if (room.type === "group") return "👥 " + room.name;
    return "✉️ " + room.name;
  }
  function renderRoomList() {
    el.roomList.replaceChildren();
    if (!state.roomList.length) {
      const li = document.createElement("li"); li.className = "tiny-note"; li.textContent = "No rooms yet. Start a direct message or create a group."; el.roomList.appendChild(li); return;
    }
    for (const room of state.roomList) {
      const li = document.createElement("li");
      const button = document.createElement("button"); button.type = "button"; button.className = "room-choice";
      button.textContent = roomDisplayName(room);
      button.setAttribute("aria-current", state.activeRoom?.id === room.id ? "true" : "false");
      const detail = document.createElement("small"); detail.textContent = room.type === "public" ? `${room.memberCount} encrypted accounts` : room.type === "group" ? `${room.memberCount} members` : "Direct message";
      button.appendChild(detail);
      button.addEventListener("click", () => selectRoom(room.id).catch(error => showAppStatus(readableError(error), "error")));
      li.appendChild(button); el.roomList.appendChild(li);
    }
  }

  async function selectRoom(roomId) {
    const room = state.roomList.find(item => item.id === roomId);
    if (!room) throw new ClientError("That room is no longer available. Refresh the room list.");
    state.activeRoom = room;
    state.latest = null; state.oldest = null; state.renderedIds.clear();
    el.messages.replaceChildren();
    el.roomTitle.textContent = roomDisplayName(room);
    el.roomSubtitle.textContent = room.type === "public"
      ? "Public group chat · each message is encrypted for accounts registered at send time."
      : room.type === "group" ? `${room.memberCount} members · encrypted for this group's members.` : "Direct message · encrypted for these two accounts.";
    el.messageInput.disabled = false;
    el.sendMessage.disabled = false;
    el.loadOlder.hidden = true;
    el.historyStatus.textContent = "Loading messages…";
    renderRoomList();
    await loadInitialMessages(roomId);
    el.messageInput.focus({ preventScroll: true });
  }

  function messageCursor(message) { return message ? { time: Number(message.createdAt), id: message.id } : null; }
  function queryCursor(base, key, cursor) {
    if (cursor) { base.searchParams.set(`${key}Time`, String(cursor.time)); base.searchParams.set(`${key}Id`, cursor.id); }
    return base;
  }
  async function fetchMessages(roomId, mode = "initial", cursor = null) {
    const url = new URL(`/api/rooms/${encodeURIComponent(roomId)}/messages`, location.origin);
    url.searchParams.set("limit", "50");
    if (mode === "after") queryCursor(url, "after", cursor);
    if (mode === "before") queryCursor(url, "before", cursor);
    return api(url.pathname + url.search);
  }
  async function loadInitialMessages(roomId) {
    const result = await fetchMessages(roomId, "initial");
    if (state.activeRoom?.id !== roomId) return;
    state.oldest = result.messages.length ? messageCursor(result.messages[0]) : null;
    state.latest = result.messages.length ? messageCursor(result.messages[result.messages.length - 1]) : null;
    state.renderedIds.clear();
    if (!result.messages.length) addEmptyNotice("No messages yet. Say hello to the village.");
    for (const message of result.messages) await renderEncryptedMessage(message, "append");
    el.loadOlder.hidden = !(result.hasOlder && state.oldest);
    el.historyStatus.textContent = result.hasOlder ? "Latest messages shown" : "Beginning of this conversation";
    scrollMessagesToBottom();
  }
  async function pollActiveRoom() {
    if (!state.activeRoom || state.pollingBusy || document.hidden) return;
    state.pollingBusy = true;
    const roomId = state.activeRoom.id;
    try {
      if (!state.latest) {
        await loadInitialMessages(roomId);
      } else {
        const result = await fetchMessages(roomId, "after", state.latest);
        if (state.activeRoom?.id !== roomId) return;
        for (const message of result.messages) {
          await renderEncryptedMessage(message, "append");
          const cursor = messageCursor(message);
          if (!state.latest || cursor.time > state.latest.time || (cursor.time === state.latest.time && cursor.id > state.latest.id)) state.latest = cursor;
        }
        if (result.messages.length) scrollMessagesToBottom();
      }
      if (state.pollFailureShown) { state.pollFailureShown = false; showAppStatus("Connection restored.", "success"); }
    } catch (error) {
      if (error.status === 401) {
        stopPolling();
        state.me = null; state.identity = null; state.activeRoom = null;
        showAuthPanel("login");
        showFeedback(el.authFeedback, "Your session has expired. Sign in again; your local private keys are still stored on this device.", "error");
      } else {
        if (!state.pollFailureShown) showAppStatus(readableError(error), "error");
        state.pollFailureShown = true;
      }
    } finally { state.pollingBusy = false; }
  }

  async function loadOlderMessages() {
    if (!state.activeRoom || !state.oldest) return;
    const roomId = state.activeRoom.id;
    setButtonBusy(el.loadOlder, true, "Loading…", "Load older messages");
    const oldHeight = el.messages.scrollHeight;
    const oldTop = el.messages.scrollTop;
    try {
      const result = await fetchMessages(roomId, "before", state.oldest);
      if (state.activeRoom?.id !== roomId) return;
      if (!result.messages.length) {
        el.loadOlder.hidden = true; el.historyStatus.textContent = "No older messages"; return;
      }
      for (const message of [...result.messages].reverse()) await renderEncryptedMessage(message, "prepend");
      state.oldest = messageCursor(result.messages[0]);
      el.messages.scrollTop = el.messages.scrollHeight - oldHeight + oldTop;
      el.loadOlder.hidden = !result.hasOlder;
      el.historyStatus.textContent = result.hasOlder ? "Older messages loaded" : "Beginning of this conversation";
    } catch (error) { showAppStatus(readableError(error), "error"); }
    finally { setButtonBusy(el.loadOlder, false); }
  }

  function addEmptyNotice(text) {
    if (el.messages.querySelector(".chat-empty")) return;
    const li = document.createElement("li"); li.className = "chat-empty"; li.textContent = text; el.messages.appendChild(li);
  }
  async function renderEncryptedMessage(message, placement) {
    if (state.renderedIds.has(message.id)) return;
    state.renderedIds.add(message.id);
    el.messages.querySelector(".chat-empty")?.remove();
    const li = document.createElement("li");
    li.className = "chat-message" + (message.senderId === state.me.id ? " mine" : "");
    li.dataset.messageId = message.id;
    const header = document.createElement("div"); header.className = "message-head";
    const author = document.createElement("strong"); author.textContent = message.senderId === state.me.id ? `${message.senderName || state.me.displayName} (you)` : (message.senderName || "Village baker");
    const time = document.createElement("time");
    const stamp = new Date(Number(message.createdAt));
    time.dateTime = Number.isFinite(stamp.getTime()) ? stamp.toISOString() : "";
    time.textContent = Number.isFinite(stamp.getTime()) ? stamp.toLocaleString() : "Unknown time";
    header.append(author, time);
    const body = document.createElement("div"); body.className = "message-body";
    const stampLabel = document.createElement("div"); stampLabel.className = "message-security";
    li.append(header, body, stampLabel);
    if (placement === "prepend") el.messages.prepend(li); else el.messages.appendChild(li);

    try {
      let trusted = state.trust.get(message.senderId);
      if (!trusted) {
        const user = { id: message.senderId, displayName: message.senderName, encryptionKey: message.senderEncryptionKey, signingKey: message.senderSigningKey };
        const result = await NanaChatCrypto.pinPublicIdentity(user);
        trusted = { ...result, user };
        state.trust.set(message.senderId, trusted);
      }
      if (!trusted.ok || trusted.user.signingKey !== message.senderSigningKey || trusted.user.encryptionKey !== message.senderEncryptionKey) {
        li.classList.add("invalid");
        body.textContent = "Security warning: this sender's public keys do not match the keys previously seen on this device. Message hidden.";
        stampLabel.textContent = "IDENTITY KEY MISMATCH";
        return;
      }
      const result = await NanaChatCrypto.decryptMessage(message, state.me.id, state.identity, message.senderSigningKey);
      if (!result.verified) {
        li.classList.add("invalid");
        body.textContent = "Security warning: message signature verification failed. Message hidden.";
        stampLabel.textContent = "SIGNATURE INVALID";
      } else if (result.notRecipient) {
        body.textContent = "This message was not encrypted for this account.";
        stampLabel.textContent = "NOT A RECIPIENT";
      } else {
        body.textContent = result.text;
        stampLabel.textContent = "🔒 SIGNATURE VERIFIED · DECRYPTED IN THIS BROWSER";
      }
    } catch {
      body.textContent = "Could not decrypt this message on this device. It may be damaged or the recovery keys may not match.";
      stampLabel.textContent = "DECRYPTION FAILED";
      li.classList.add("invalid");
    }
  }
  function scrollMessagesToBottom() { el.messages.scrollTop = el.messages.scrollHeight; }

  async function sendMessage(event) {
    event.preventDefault();
    const text = el.messageInput.value;
    if (!text.trim()) return showAppStatus("Write a message before sending.", "error");
    if ([...text].length > MAX_TEXT) return showAppStatus(`Messages are limited to ${MAX_TEXT} characters.`, "error");
    if (!state.activeRoom || state.sendBusy) return;
    state.sendBusy = true;
    setButtonBusy(el.sendMessage, true, "Encrypting…", "Encrypt & send");
    el.messageInput.disabled = true;
    try {
      const recipientResult = await api(`/api/rooms/${encodeURIComponent(state.activeRoom.id)}/recipients`);
      for (const user of recipientResult.users) {
        const trust = await NanaChatCrypto.pinPublicIdentity(user);
        state.trust.set(user.id, { ...trust, user });
        if (!trust.ok) {
          state.trustFailures.set(user.id, `Public keys for ${user.displayName} changed since this browser first saw them.`);
          throw new ClientError(`Cannot send: the public keys for ${user.displayName} changed. Verify them out of band before continuing.`);
        }
      }
      if (!recipientResult.users.some(user => user.id === state.me.id)) throw new ClientError("Your account is missing from the room's recipient list. Refresh and sign in again.");
      const messageId = NanaChatCrypto.randomId();
      const encrypted = await NanaChatCrypto.encryptMessage(text, state.activeRoom.id, messageId, state.me.id, recipientResult.users, state.identity);
      await api(`/api/rooms/${encodeURIComponent(state.activeRoom.id)}/messages`, { method: "POST", body: JSON.stringify(encrypted) });
      el.messageInput.value = "";
      updateMessageCount();
      showAppStatus("Message encrypted, signed, and sent.", "success");
      await pollActiveRoom();
    } catch (error) {
      showAppStatus(readableError(error), "error");
    } finally {
      state.sendBusy = false;
      el.messageInput.disabled = false;
      setButtonBusy(el.sendMessage, false);
      el.messageInput.focus({ preventScroll: true });
    }
  }

  async function updateProfile(event) {
    event.preventDefault();
    const displayName = el.profileName.value.trim();
    if (!displayName || [...displayName].length > 32) return showAppStatus("Display name must be between 1 and 32 characters.", "error");
    const submit = el.profileForm.querySelector('button[type="submit"]');
    setButtonBusy(submit, true, "Saving…", "Save name");
    try {
      const result = await api("/api/me/profile", { method: "PATCH", body: JSON.stringify({ displayName }) });
      state.me = { ...state.me, ...result.user };
      el.signedInName.textContent = state.me.displayName;
      showAppStatus("Display name updated.", "success");
      await refreshDirectory();
      await refreshRooms();
      if (state.activeRoom) {
        const room = state.roomList.find(item => item.id === state.activeRoom.id);
        if (room) { state.activeRoom = room; el.roomSubtitle.textContent = room.type === "public" ? "Public group chat · each message is encrypted for accounts registered at send time." : room.type === "group" ? `${room.memberCount} members · encrypted for this group's members.` : "Direct message · encrypted for these two accounts."; }
      }
    } catch (error) { showAppStatus(readableError(error), "error"); }
    finally { setButtonBusy(submit, false); }
  }

  async function createDirectMessage() {
    const userId = el.dmPerson.value;
    if (!userId) return showAppStatus("Choose a baker first.", "error");
    if (state.trustFailures.has(userId)) return showAppStatus("This user's key changed. Verify the identity before starting a conversation.", "error");
    setButtonBusy(el.openDm, true, "Opening…", "Open direct message");
    try {
      const result = await api("/api/rooms", { method: "POST", body: JSON.stringify({ type: "dm", memberIds: [userId] }) });
      await refreshRooms();
      await selectRoom(result.room.id);
      showAppStatus(result.existing ? "Opened existing direct message." : "Direct message created. Content will be encrypted for both accounts.", "success");
    } catch (error) { showAppStatus(readableError(error), "error"); }
    finally { setButtonBusy(el.openDm, false); }
  }
  async function createGroup(event) {
    event.preventDefault();
    const name = el.groupName.value.trim();
    const memberIds = [...el.groupMemberOptions.querySelectorAll('input[name="group-member"]:checked:not(:disabled)')].map(input => input.value);
    if (!name) return showAppStatus("Give the group a name.", "error");
    if (!memberIds.length) return showAppStatus("Choose at least one other baker.", "error");
    setButtonBusy(el.groupForm.querySelector('button[type="submit"]'), true, "Creating…", "Create private group");
    try {
      const result = await api("/api/rooms", { method: "POST", body: JSON.stringify({ type: "group", name, memberIds }) });
      el.groupForm.reset(); el.groupForm.hidden = true;
      await refreshRooms(); await selectRoom(result.room.id);
      showAppStatus("Private group created. Each message will be encrypted for its members.", "success");
    } catch (error) { showAppStatus(readableError(error), "error"); }
    finally { const submit = el.groupForm.querySelector('button[type="submit"]'); if (submit) { submit.disabled = false; submit.textContent = "Create private group"; delete submit.dataset.normalText; } }
  }

  async function logout() {
    setButtonBusy(el.logout, true, "Signing out…", "Sign out");
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); }
    catch (error) { if (error.status !== 401) showAppStatus(readableError(error), "error"); }
    stopPolling();
    state.me = null; state.identity = null; state.pendingIdentity = null; state.activeRoom = null;
    state.directory = []; state.directoryMap.clear(); state.trust.clear(); state.roomList = []; state.renderedIds.clear();
    el.messages.replaceChildren(); el.code.value = "";
    showAuthPanel("login");
    showFeedback(el.authFeedback, "Signed out. This browser's encrypted private keys remain stored locally for next time.", "success");
    setButtonBusy(el.logout, false);
  }
  function stopPolling() {
    if (state.polling) clearInterval(state.polling);
    if (state.directoryRefreshTimer) clearInterval(state.directoryRefreshTimer);
    state.polling = null; state.directoryRefreshTimer = null;
  }
  function updateMessageCount() { el.messageCount.textContent = `${[...el.messageInput.value].length} / ${MAX_TEXT}`; }
  async function downloadExistingBackup() {
    try {
      const record = state.identity || (state.me ? await NanaChatCrypto.getIdentity(state.me.id) : null);
      if (!record?.backupText) throw new ClientError("No encrypted recovery file is stored on this device.");
      NanaChatCrypto.downloadBackup(record.backupText);
      showAppStatus("Encrypted recovery file downloaded. You still need the separate recovery code to restore it.", "success");
    } catch (error) { showAppStatus(readableError(error), "error"); }
  }

  el.loginForm.addEventListener("submit", requestLoginCode);
  el.verifyForm.addEventListener("submit", verifyLoginCode);
  el.changeEmail.addEventListener("click", () => { el.code.value = ""; showAuthPanel("login"); showFeedback(el.authFeedback, "Enter an email address to request a new one-time code."); });
  el.downloadFirstBackup.addEventListener("click", downloadFirstBackup);
  el.copyRecoveryCode.addEventListener("click", copyRecoveryCode);
  el.recoverySaved.addEventListener("change", maybeEnableFinish);
  el.finishKeySetup.addEventListener("click", finishKeySetup);
  el.recoveryForm.addEventListener("submit", restoreKeys);
  el.logout.addEventListener("click", logout);
  el.downloadBackup.addEventListener("click", downloadExistingBackup);
  el.profileForm.addEventListener("submit", updateProfile);
  el.newGroupToggle.addEventListener("click", () => { el.groupForm.hidden = !el.groupForm.hidden; if (!el.groupForm.hidden) el.groupName.focus(); });
  el.cancelGroup.addEventListener("click", () => { el.groupForm.reset(); el.groupForm.hidden = true; });
  el.groupForm.addEventListener("submit", createGroup);
  el.openDm.addEventListener("click", createDirectMessage);
  el.sendForm.addEventListener("submit", sendMessage);
  el.loadOlder.addEventListener("click", loadOlderMessages);
  el.messageInput.addEventListener("input", updateMessageCount);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollActiveRoom().catch(() => {}); });
  bootstrap().catch(error => showFeedback(el.authFeedback, readableError(error), "error"));
})();
