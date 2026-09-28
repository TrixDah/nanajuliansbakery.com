import sodium from "libsodium-wrappers";

const b64 = (u8) => sodium.to_base64(u8, sodium.base64_variants.ORIGINAL);
const unb64 = (s) => sodium.from_base64(s, sodium.base64_variants.ORIGINAL);

function wrapKey(exportKey, salt) {
  const ikm = sodium.crypto_generichash(32, sodium.from_string(exportKey));
  const info = new Uint8Array([...sodium.from_string("bakery-wrap-v1"), ...salt]);
  return sodium.crypto_generichash(32, info, ikm);
}

function seal(privateKey, exportKey) {
  const salt = sodium.randombytes_buf(16);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ct = sodium.crypto_secretbox_easy(privateKey, nonce, wrapKey(exportKey, salt));
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce);
  out.set(ct, nonce.length);
  return { encryptedPrivateKey: b64(out), privateKeySalt: b64(salt) };
}

export async function makeKeyPackage(exportKey) {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  return { publicKey: b64(kp.publicKey), ...seal(kp.privateKey, exportKey) };
}

export async function unwrapPrivateKey(exportKey, encryptedPrivateKey, privateKeySalt) {
  await sodium.ready;
  const raw = unb64(encryptedPrivateKey);
  const n = sodium.crypto_secretbox_NONCEBYTES;
  return sodium.crypto_secretbox_open_easy(
    raw.slice(n), raw.slice(0, n), wrapKey(exportKey, unb64(privateKeySalt))
  );
}

export async function rewrap(oldExportKey, newExportKey, encryptedPrivateKey, privateKeySalt) {
  const pk = await unwrapPrivateKey(oldExportKey, encryptedPrivateKey, privateKeySalt);
  return seal(pk, newExportKey);
}
