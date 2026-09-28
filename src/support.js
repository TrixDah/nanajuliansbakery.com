import { login, me, logout } from "./auth.js";

const status = document.getElementById("status");
const form = document.getElementById("login");
const out = document.getElementById("logout");

async function refresh() {
  const r = await me();
  status.textContent = r ? "connected to support agent" : "Hi! How can we help you today?";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = form.password.value;
  form.password.value = "";
  const r = await login(pw);
  status.textContent = r ? "connected to support agent" : "Sorry, I didn't understand that.";
});

out.addEventListener("click", async () => { await logout(); refresh(); });
refresh();
