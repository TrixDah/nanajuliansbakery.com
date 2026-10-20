import test from "node:test";
import assert from "node:assert/strict";
if (!globalThis.indexedDB) Object.defineProperty(globalThis, "indexedDB", { value: {}, configurable: true });
globalThis.window = {};
await import("../assets/chat-crypto.js");
const ChatCrypto = globalThis.window.NanaChatCrypto;
const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("hybrid message encryption round-trips and verifies sender signatures", async () => {
  const identityA = await ChatCrypto.generateNewIdentity();
  const identityB = await ChatCrypto.generateNewIdentity();
  assert.equal(identityA.privateEncryptionKey.extractable, false);
  assert.equal(identityA.privateSigningKey.extractable, false);

  const roomId = "village-square";
  const messageId = ChatCrypto.randomId();
  const message = await ChatCrypto.encryptMessage("A secret loaf is cooling.", roomId, messageId, userA, [
    { id: userA, encryptionKey: identityA.encryptionKey },
    { id: userB, encryptionKey: identityB.encryptionKey }
  ], identityA);
  message.roomId = roomId;
  message.senderId = userA;

  // Match the server's independent canonical-signature representation, not only the client verifier.
  const serverPayload = JSON.stringify([1, messageId, roomId, userA, message.iv, message.ciphertext,
    Object.keys(message.envelopes).sort().map(id => [id, message.envelopes[id]])]);
  const serverVerifyKey = await crypto.subtle.importKey("spki", Buffer.from(identityA.signingKey, "base64"),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, serverVerifyKey,
    Buffer.from(message.signature, "base64"), new TextEncoder().encode(serverPayload)), true);

  const fromA = await ChatCrypto.decryptMessage(message, userA, identityA, identityA.signingKey);
  assert.deepEqual(fromA, { verified: true, text: "A secret loaf is cooling." });
  const fromB = await ChatCrypto.decryptMessage(message, userB, identityB, identityA.signingKey);
  assert.deepEqual(fromB, { verified: true, text: "A secret loaf is cooling." });

  const tampered = { ...message, ciphertext: message.ciphertext.slice(0, -4) + "AAAA" };
  const invalid = await ChatCrypto.decryptMessage(tampered, userA, identityA, identityA.signingKey);
  assert.equal(invalid.verified, false);
});

test("recovery file unlocks matching private keys and rejects a wrong recovery code", async () => {
  const identity = await ChatCrypto.generateNewIdentity();
  const restored = await ChatCrypto.restoreIdentity(userA, identity.backupText, identity.recoveryCode, identity.encryptionKey, identity.signingKey);
  assert.equal(restored.encryptionKey, identity.encryptionKey);
  assert.equal(restored.signingKey, identity.signingKey);
  assert.equal(restored.privateEncryptionKey.extractable, false);
  await assert.rejects(
    () => ChatCrypto.restoreIdentity(userA, identity.backupText, ChatCrypto.randomId(), identity.encryptionKey, identity.signingKey),
    /did not unlock|Recovery code format/
  );
});
