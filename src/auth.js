import * as opaque from "@serenity-kit/opaque";

const API = "https://api.nanajuliansbakery.com";
const IDENTITIES = ["user1", "user2"];

async function post(path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, data };
}

export async function loginAs(username, password) {
  await opaque.ready;
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });
  const s = await post("/auth/login/start", { username, startLoginRequest });
  if (!s.ok) return null;
  let result;
  try {
    result = opaque.client.finishLogin({ clientLoginState, loginResponse: s.data.loginResponse, password });
  } catch { return null; }
  if (!result) return null;
  const { finishLoginRequest, exportKey } = result;
  const f = await post("/auth/login/finish", { flowId: s.data.flowId, finishLoginRequest });
  if (!f.ok) return null;
  return { username, exportKey };
}

export async function login(password) {
  for (const id of IDENTITIES) {
    const r = await loginAs(id, password);
    if (r) return r;
  }
  return null;
}

export async function me() {
  const r = await fetch(API + "/auth/me", { credentials: "include" });
  return r.ok ? r.json() : null;
}

export async function logout() {
  return post("/auth/logout", {});
}
