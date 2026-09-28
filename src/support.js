import { login, me, logout } from "./auth.js";

const status = document.getElementById("status");
const form = document.getElementById("login");
const out = document.getElementById("logout");

async function refresh() {
  const r = await me();
  status.textContent = r ? "logged in as " + r.username : "not logged in";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await login(form.username.value, form.password.value);
    form.password.value = "";
  } catch (err) {
    status.textContent = "error: " + err.message;
    return;
  }
  refresh();
});

out.addEventListener("click", async () => { await logout(); refresh(); });
refresh();
