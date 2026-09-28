import * as opaque from "@serenity-kit/opaque";
import { loginAs, me, logout } from "./auth.js";
import { rewrap } from "./keys.js";

const API = "https://api.nanajuliansbakery.com";

async function post(path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { ok: r.ok, data };
}

export async function changePassword(identity, oldPw, newPw) {
  await opaque.ready;
  if (typeof newPw !== "string" || newPw.length === 0) throw new Error("fail1");

  const other = identity === "user1" ? "user2" : "user1";
  if (await loginAs(other, newPw)) { await logout(); throw new Error("fail2"); }

  const session = await loginAs(identity, oldPw);
  if (!session) throw new Error("fail3");

  const profile = await me();
  if (!profile) throw new Error("fail4");

  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password: newPw });
  const s = await post("/auth/password/start", { registrationRequest });
  if (!s.ok) throw new Error("fail5");

  const { registrationRecord, exportKey } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse: s.data.registrationResponse,
    password: newPw,
  });

  const pkg = await rewrap(
    session.exportKey, exportKey,
    profile.encryptedPrivateKey, profile.privateKeySalt
  );
  const f = await post("/auth/password/finish", { registrationRecord, ...pkg });
  if (!f.ok) throw new Error("fail6");
  return true;
}
