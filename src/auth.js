import * as opaque from "@serenity-kit/opaque";

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
  return { ok: r.ok, status: r.status, data };
}

export async function login(username, password) {
  await opaque.ready;
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });
  const s = await post("/auth/login/start", { username, startLoginRequest });
  if (!s.ok) throw new Error("login start " + s.status);
  const result = opaque.client.finishLogin({
    clientLoginState,
    loginResponse: s.data.loginResponse,
    password,
  });
  if (!result) throw new Error("login failed");
  const { finishLoginRequest, exportKey } = result;
  const f = await post("/auth/login/finish", { flowId: s.data.flowId, finishLoginRequest });
  if (!f.ok) throw new Error("login finish " + f.status);
  return { exportKey };
}

export async function me() {
  const r = await fetch(API + "/auth/me", { credentials: "include" });
  return r.ok ? r.json() : null;
}

export async function logout() {
  return post("/auth/logout", {});
}
