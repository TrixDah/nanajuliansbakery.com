import sodium from "libsodium-wrappers";

const b64 = (bytes) =>
  sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);

const unb64 = (value) =>
  sodium.from_base64(value, sodium.base64_variants.ORIGINAL);

export async function ready() {
  await sodium.ready;
}

export function createRoomKey() {
  return sodium.randombytes_buf(
    sodium.crypto_secretbox_KEYBYTES
  );
}

export function sealRoomKey(roomKey, publicKey) {
  return sodium.crypto_box_seal(
    roomKey,
    publicKey
  );
}

export function openRoomKey(sealedKey, publicKey, privateKey) {
  return sodium.crypto_box_seal_open(
    sealedKey,
    publicKey,
    privateKey
  );
}

export function encryptMessage(text, roomKey) {
  const plaintext = sodium.from_string(text);

  const nonce = sodium.randombytes_buf(
    sodium.crypto_secretbox_NONCEBYTES
  );

  const ciphertext = sodium.crypto_secretbox_easy(
    plaintext,
    nonce,
    roomKey
  );

  return {
    ciphertext: b64(ciphertext),
    nonce: b64(nonce),
  };
}

export function decryptMessage(ciphertext, nonce, roomKey) {
  const plaintext = sodium.crypto_secretbox_open_easy(
    unb64(ciphertext),
    unb64(nonce),
    roomKey
  );

  return sodium.to_string(plaintext);
}

export function decodeBase64(value) {
  return unb64(value);
}
