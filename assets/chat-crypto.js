/* Client-side cryptography for Bake A Message. No private key is sent to the server. */
(() => {
  "use strict";
  const DB_NAME = "nana-bake-a-message-keys-v1";
  const DB_VERSION = 1;
  const KEY_STORE = "identities";
  const PIN_STORE = "trusted-keys";
  const RECOVERY_ITERATIONS = 600000;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const RECOVERY_AAD = encoder.encode("NanaJulianE2EERecoveryBackup:v1");
  const CRYPTO_TAG = "nana-chat-e2ee-v1";

  function getSubtle() {
    if (!globalThis.crypto?.subtle || !globalThis.indexedDB) {
      throw new Error("Secure browser cryptography or IndexedDB is unavailable. Open this page over HTTPS or localhost in a current browser.");
    }
    return globalThis.crypto.subtle;
  }
  function bytesToB64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(binary);
  }
  function b64ToBytes(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error("Invalid base64 data.");
    const binary = atob(value);
    const output = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) output[i] = binary.charCodeAt(i);
    return output;
  }
  function bytesToBase64Url(bytes) { return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
  function base64UrlToBytes(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(value)) throw new Error("Recovery code format is invalid.");
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    return b64ToBytes(base64);
  }
  function randomId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(v => v.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE, { keyPath: "userId" });
        if (!db.objectStoreNames.contains(PIN_STORE)) db.createObjectStore(PIN_STORE, { keyPath: "userId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open encrypted key storage."));
      request.onblocked = () => reject(new Error("Key storage is blocked by another open tab. Close older chat tabs and retry."));
    });
  }
  async function storeGet(storeName, key) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const request = tx.objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error("Could not read local key storage."));
      });
    } finally { db.close(); }
  }
  async function storePut(storeName, value) {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("Could not save local key storage."));
        tx.onabort = () => reject(tx.error || new Error("Saving local key storage was aborted."));
      });
    } finally { db.close(); }
  }
  async function getIdentity(userId) { return storeGet(KEY_STORE, userId); }
  async function saveIdentity(record) { await storePut(KEY_STORE, record); }
  async function getPinnedKey(userId) { return storeGet(PIN_STORE, userId); }
  async function pinPublicIdentity(user) {
    const previous = await getPinnedKey(user.id);
    const current = { userId: user.id, encryptionKey: user.encryptionKey, signingKey: user.signingKey };
    if (previous && (previous.encryptionKey !== current.encryptionKey || previous.signingKey !== current.signingKey)) return { ok: false, previous, current };
    if (!previous) await storePut(PIN_STORE, current);
    return { ok: true, current };
  }
  async function exportSpki(key) { return bytesToB64(new Uint8Array(await getSubtle().exportKey("spki", key))); }
  async function fingerprint(user) {
    const bytes = encoder.encode(`${user.encryptionKey}\n${user.signingKey}`);
    const digest = new Uint8Array(await getSubtle().digest("SHA-256", bytes));
    const hex = [...digest].map(value => value.toString(16).padStart(2, "0")).join("").toUpperCase();
    return hex.match(/.{1,4}/g).join(" ");
  }
  async function importEncryptionPublicKey(spki) {
    const key = await getSubtle().importKey("spki", b64ToBytes(spki), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
    if (key.algorithm.modulusLength < 3072) throw new Error("An encryption key is smaller than the required RSA-3072 size.");
    return key;
  }
  async function importSigningPublicKey(spki) {
    const key = await getSubtle().importKey("spki", b64ToBytes(spki), { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
    if (key.algorithm.namedCurve !== "P-256") throw new Error("An unsupported signing key was received.");
    return key;
  }
  async function importPrivateJwk(jwk, kind) {
    if (kind === "encryption") return getSubtle().importKey("jwk", jwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
    return getSubtle().importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }
  async function generateNewIdentity() {
    const subtle = getSubtle();
    const encryptionPair = await subtle.generateKey({ name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
    const signingPair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const encryptionKey = await exportSpki(encryptionPair.publicKey);
    const signingKey = await exportSpki(signingPair.publicKey);
    const privateJwk = {
      encryption: await subtle.exportKey("jwk", encryptionPair.privateKey),
      signing: await subtle.exportKey("jwk", signingPair.privateKey)
    };
    const recoveryCode = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrappingKey = await deriveRecoveryKey(recoveryCode, salt);
    const plaintext = encoder.encode(JSON.stringify({ version: 1, encryptionKey, signingKey, privateJwk }));
    const encrypted = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: RECOVERY_AAD, tagLength: 128 }, wrappingKey, plaintext);
    const backup = {
      format: "nana-julian-e2ee-recovery",
      version: 1,
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: RECOVERY_ITERATIONS, salt: bytesToB64(salt) },
      cipher: { name: "AES-GCM", iv: bytesToB64(iv), ciphertext: bytesToB64(new Uint8Array(encrypted)) }
    };
    const privateEncryptionKey = await importPrivateJwk(privateJwk.encryption, "encryption");
    const privateSigningKey = await importPrivateJwk(privateJwk.signing, "signing");
    return {
      userId: null, privateEncryptionKey, privateSigningKey, encryptionKey, signingKey,
      backupText: JSON.stringify(backup, null, 2), recoveryCode,
      // This private, extractable pair exists only while the setup screen is open.
      discardAfterSave: true
    };
  }
  async function deriveRecoveryKey(code, salt) {
    const subtle = getSubtle();
    const codeBytes = base64UrlToBytes(code.trim().replace(/\s+/g, ""));
    const material = await subtle.importKey("raw", codeBytes, "PBKDF2", false, ["deriveKey"]);
    codeBytes.fill(0);
    return subtle.deriveKey({ name: "PBKDF2", salt, iterations: RECOVERY_ITERATIONS, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt", "encrypt"]);
  }
  async function restoreIdentity(userId, backupText, recoveryCode, expectedEncryptionKey, expectedSigningKey) {
    const backup = JSON.parse(backupText);
    if (backup?.format !== "nana-julian-e2ee-recovery" || backup.version !== 1 || backup.kdf?.iterations !== RECOVERY_ITERATIONS || backup.cipher?.name !== "AES-GCM") throw new Error("This does not look like a supported Nana Julian recovery file.");
    const wrappingKey = await deriveRecoveryKey(recoveryCode, b64ToBytes(backup.kdf.salt));
    let clearBytes;
    try {
      clearBytes = new Uint8Array(await getSubtle().decrypt({ name: "AES-GCM", iv: b64ToBytes(backup.cipher.iv), additionalData: RECOVERY_AAD, tagLength: 128 }, wrappingKey, b64ToBytes(backup.cipher.ciphertext)));
    } catch { throw new Error("The recovery code did not unlock this file, or the file was damaged."); }
    let data;
    try { data = JSON.parse(decoder.decode(clearBytes)); } finally { clearBytes.fill(0); }
    if (data?.version !== 1 || data.encryptionKey !== expectedEncryptionKey || data.signingKey !== expectedSigningKey || !data.privateJwk?.encryption || !data.privateJwk?.signing) {
      throw new Error("These recovery keys do not match the keys registered to this account. Check that you chose the right file and account.");
    }
    const privateEncryptionKey = await importPrivateJwk(data.privateJwk.encryption, "encryption");
    const privateSigningKey = await importPrivateJwk(data.privateJwk.signing, "signing");
    return { userId, privateEncryptionKey, privateSigningKey, encryptionKey: data.encryptionKey, signingKey: data.signingKey, backupText };
  }
  async function encryptMessage(text, roomId, messageId, senderId, recipients, identity) {
    const subtle = getSubtle();
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const messageKey = await subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
    const aad = encoder.encode(`${CRYPTO_TAG}:${roomId}:${messageId}:${senderId}`);
    const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, messageKey, encoder.encode(text));
    const envelopes = Object.create(null);
    try {
      for (const recipient of recipients) {
        if (!recipient?.id || !recipient.encryptionKey) throw new Error("A recipient is missing an encryption key. Refresh the room and try again.");
        const publicKey = await importEncryptionPublicKey(recipient.encryptionKey);
        const wrapped = await subtle.encrypt({ name: "RSA-OAEP" }, publicKey, keyBytes);
        envelopes[recipient.id] = bytesToB64(new Uint8Array(wrapped));
      }
      if (!envelopes[senderId]) throw new Error("Your own key is not included in this room's recipient list.");
      const signed = { version: 1, id: messageId, roomId, senderId, iv: bytesToB64(iv), ciphertext: bytesToB64(new Uint8Array(ciphertext)), envelopes };
      const signature = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateSigningKey, encoder.encode(canonicalSignaturePayload(signed)));
      return { ...signed, signature: bytesToB64(new Uint8Array(signature)) };
    } finally { keyBytes.fill(0); }
  }
  function canonicalSignaturePayload(message) {
    const sortedEnvelopes = Object.keys(message.envelopes || {}).sort().map(id => [id, message.envelopes[id]]);
    return JSON.stringify([message.version, message.id, message.roomId, message.senderId, message.iv, message.ciphertext, sortedEnvelopes]);
  }
  async function verifyMessageSignature(message, signingKeySpki) {
    try {
      const key = await importSigningPublicKey(signingKeySpki);
      const signature = b64ToBytes(message.signature);
      return await getSubtle().verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, encoder.encode(canonicalSignaturePayload(message)));
    } catch { return false; }
  }
  async function decryptMessage(message, userId, identity, signingKeySpki) {
    const verified = await verifyMessageSignature(message, signingKeySpki);
    if (!verified) return { verified: false, text: null };
    const wrapped = message.envelopes?.[userId];
    if (!wrapped) return { verified: true, text: null, notRecipient: true };
    const keyBytes = new Uint8Array(await getSubtle().decrypt({ name: "RSA-OAEP" }, identity.privateEncryptionKey, b64ToBytes(wrapped)));
    try {
      const key = await getSubtle().importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
      const aad = encoder.encode(`${CRYPTO_TAG}:${message.roomId}:${message.id}:${message.senderId}`);
      const clear = new Uint8Array(await getSubtle().decrypt({ name: "AES-GCM", iv: b64ToBytes(message.iv), additionalData: aad, tagLength: 128 }, key, b64ToBytes(message.ciphertext)));
      try { return { verified: true, text: decoder.decode(clear) }; } finally { clear.fill(0); }
    } finally { keyBytes.fill(0); }
  }
  function downloadBackup(backupText) {
    if (!backupText) throw new Error("No recovery backup exists on this device.");
    const blob = new Blob([backupText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "nana-julian-encrypted-recovery.json";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  window.NanaChatCrypto = Object.freeze({
    generateNewIdentity, restoreIdentity, saveIdentity, getIdentity, pinPublicIdentity,
    encryptMessage, decryptMessage, downloadBackup, randomId, bytesToB64, b64ToBytes, fingerprint,
    importEncryptionPublicKey, importSigningPublicKey
  });
})();
