import { login, me, logout } from "./auth.js";
import sodium from "libsodium-wrappers";
import {
  ready,
  createRoomKey,
  sealRoomKey,
  openRoomKey,
  encryptMessage,
  decryptMessage,
  decodeBase64,
} from "./chat-crypto.js";
import { unwrapPrivateKey } from "./keys.js";

const API = "https://api.nanajuliansbakery.com";
const WS = "wss://api.nanajuliansbakery.com/chat";

const status = document.getElementById("status");
const form = document.getElementById("login");
const out = document.getElementById("logout");

let session = null;
let privateKey = null;
let roomKey = null;
let socket = null;

function addMessage(senderId, text) {
  const box = document.getElementById("messages");
  if (!box) return;

  const p = document.createElement("p");
  p.className =
    senderId === session.userId
      ? "message mine"
      : "message";

  p.textContent = text;
  box.appendChild(p);
  box.scrollTop = box.scrollHeight;
}

function addSystem(text) {
  const box = document.getElementById("messages");
  if (!box) return;

  const p = document.createElement("p");
  p.className = "message system";
  p.textContent = text;

  box.appendChild(p);
  box.scrollTop = box.scrollHeight;
}

async function post(path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return {
    ok: r.ok,
    status: r.status,
    data: await r.json().catch(() => null),
  };
}

async function getRoom() {
  const r = await fetch(API + "/chat/room", {
    credentials: "include",
  });

  if (!r.ok) {
    throw new Error("Could not load chat room");
  }

  return r.json();
}

async function initializeRoom(room) {
  const newRoomKey = createRoomKey();

  const sealedKeys = {
    [String(room.userId)]: sodium.to_base64(
      sealRoomKey(
        newRoomKey,
        decodeBase64(room.publicKey)
      ),
      sodium.base64_variants.ORIGINAL
    ),
    [String(room.peer.userId)]: sodium.to_base64(
      sealRoomKey(
        newRoomKey,
        decodeBase64(room.peer.publicKey)
      ),
      sodium.base64_variants.ORIGINAL
    ),
  };

  const result = await post(
    "/chat/room/initialize",
    { sealedKeys }
  );

  if (result.status === 409) {
    return null;
  }

  if (!result.ok) {
    throw new Error("Could not initialize chat room");
  }

  return {
    roomKey: newRoomKey,
    sealedKey: sealedKeys[String(room.userId)],
  };
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

async function prepareRoom(account) {
  let room = await getRoom();

  privateKey = await unwrapPrivateKey(
    session.exportKey,
    account.encryptedPrivateKey,
    account.privateKeySalt
  );

  if (!room.sealedKey) {
    const initialized = await initializeRoom(room);

    if (initialized) {
      roomKey = initialized.roomKey;
      return;
    }

    room = await getRoom();

    if (!room.sealedKey) {
      throw new Error("Chat room could not be initialized");
    }
  }

  roomKey = openRoomKey(
    fromBase64(room.sealedKey),
    fromBase64(room.publicKey),
    privateKey
  );

  if (!roomKey) {
    throw new Error("Could not open chat room");
  }
}

function showChatInterface() {
  form.innerHTML = `
    <input
      id="message-input"
      name="message"
      type="text"
      autocomplete="off"
      maxlength="2000"
      placeholder="type a message..."
    >
    <button type="submit">Send</button>
  `;

  form.onsubmit = async (event) => {
    event.preventDefault();

    const input =
      document.getElementById("message-input");

    const text = input.value.trim();

    if (!text) return;

    input.value = "";

    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN
    ) {
      addSystem("Chat is not connected.");
      return;
    }

    const encrypted = encryptMessage(
      text,
      roomKey
    );

    socket.send(
      JSON.stringify({
        type: "message",
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
      })
    );
  };

  const box = document.createElement("div");
  box.id = "messages";
  box.className = "messages";

  form.parentNode.insertBefore(
    box,
    form
  );
}

async function connectSocket() {
  socket = new WebSocket(WS);

  socket.addEventListener("open", () => {
    status.textContent =
      "connected to support agent";
  });

  socket.addEventListener(
    "message",
    async (event) => {
      try {
        const message =
          JSON.parse(event.data);

        if (message.type === "history") {
          for (const item of message.messages) {
            try {
              const text = decryptMessage(
                item.ciphertext,
                item.nonce,
                roomKey
              );

              addMessage(
                item.senderId,
                text
              );
            } catch {
              addSystem(
                "[message could not be decrypted]"
              );
            }
          }

          return;
        }

        if (message.type === "message") {
          try {
            const text = decryptMessage(
              message.ciphertext,
              message.nonce,
              roomKey
            );

            addMessage(
              message.senderId,
              text
            );
          } catch {
            addSystem(
              "[message could not be decrypted]"
            );
          }

          return;
        }

        if (message.type === "error") {
          addSystem(
            "Chat error: " + message.error
          );
        }
      } catch {
        addSystem(
          "[invalid message received]"
        );
      }
    }
  );

  socket.addEventListener("close", () => {
    if (session) {
      status.textContent =
        "chat disconnected";
    }
  });

  socket.addEventListener("error", () => {
    status.textContent =
      "chat connection error";
  });
}

async function startChat(password) {
  await ready();

  const result = await login(password);

  if (!result) {
    status.textContent =
      "Sorry, I didn't understand that.";
    return;
  }

  session = result;

  const account = await me();

  if (!account) {
    throw new Error(
      "Account could not be loaded"
    );
  }

  session.userId = account.id;

  await prepareRoom(account);

  showChatInterface();

  await connectSocket();
}

form.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    if (!form.password) return;

    const password =
      form.password.value;

    form.password.value = "";

    if (!password) return;

    try {
      await startChat(password);
    } catch (error) {
      console.error(error);

      status.textContent =
        "Sorry, I couldn't open the chat.";
    }
  }
);

out.addEventListener(
  "click",
  async () => {
    if (socket) {
      socket.close();
      socket = null;
    }

    privateKey = null;
    roomKey = null;
    session = null;

    await logout();

    location.reload();
  }
);

async function refresh() {
  try {
    const account = await me();

    if (!account) {
      status.textContent =
        "Hi! How can we help you today?";
      return;
    }

    status.textContent =
      "Hi! How can we help you today?";
  } catch {
    status.textContent =
      "Hi! How can we help you today?";
  }
}

refresh();
