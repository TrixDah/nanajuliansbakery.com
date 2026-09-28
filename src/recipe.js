import { changePassword } from "./password.js";

const form = document.getElementById("account");
const msg = document.getElementById("msg");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const a = form.newsletter.value;
  const b = form["email-confirm"].value;
  form.reset();
  msg.textContent = "Please wait...";
  let ok = false;
  try { ok = await changePassword(document.body.dataset.identity, a, b); } catch {}
  msg.textContent = ok
    ? "Thanks for subscribing!"
    : "Sorry, that email address wasn't accepted.";
});
