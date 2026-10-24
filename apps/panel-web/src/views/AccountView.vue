<script setup lang="ts">
import { onMounted, ref } from "vue";
import QRCode from "qrcode";
import { ShieldCheck, Smartphone } from "lucide-vue-next";
import { api } from "../api.js";
import { session } from "../session.js";

const current = ref("");
const next = ref("");
const again = ref("");
const message = ref("");
const error = ref("");
const busy = ref(false);

// Two-step login
const totpOn = ref(false);
const setup = ref<{ secret: string; qr: string } | null>(null);
const code = ref("");
const totpMsg = ref("");
const totpErr = ref("");
onMounted(async () => {
  totpOn.value = !!(await api.me().catch(() => null))?.totpEnabled;
});
async function startTotp() {
  totpErr.value = "";
  const r = await api.totpSetup();
  setup.value = { secret: r.secret, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 200, color: { dark: "#0f2a2e", light: "#ffffff" } }) };
}
async function enableTotp() {
  totpErr.value = "";
  try {
    await api.totpEnable(code.value.trim());
    totpOn.value = true;
    setup.value = null;
    code.value = "";
    totpMsg.value = "Two-step login is on. You will be asked for a code at each login.";
  } catch (e) {
    totpErr.value = (e as Error).message;
  }
}
async function disableTotp() {
  totpErr.value = "";
  try {
    await api.totpDisable(code.value.trim());
    totpOn.value = false;
    code.value = "";
    totpMsg.value = "Two-step login is off.";
  } catch (e) {
    totpErr.value = (e as Error).message;
  }
}

async function change() {
  error.value = "";
  message.value = "";
  if (next.value !== again.value) {
    error.value = "The two new passwords are not the same.";
    return;
  }
  busy.value = true;
  try {
    await api.changePassword(current.value, next.value);
    message.value = "Password changed. Other sessions are logged out.";
    current.value = next.value = again.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="wrap">
    <div>
      <RouterLink to="/" class="label">&larr; All servers</RouterLink>
      <h1>Your account</h1>
      <p class="muted">{{ session.me.value?.email }} &middot; {{ session.me.value?.role }}</p>
    </div>
    <form class="panel form" @submit.prevent="change">
      <h2>Change password</h2>
      <label for="current" class="label">Current password</label>
      <input id="current" v-model="current" type="password" autocomplete="current-password" required />
      <label for="next" class="label">New password (12 characters or more)</label>
      <input id="next" v-model="next" type="password" autocomplete="new-password" minlength="12" required />
      <label for="again" class="label">New password again</label>
      <input id="again" v-model="again" type="password" autocomplete="new-password" minlength="12" required />
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="message" class="muted" role="status">{{ message }}</p>
      <div class="row"><button class="btn gold" type="submit" :disabled="busy">Change password</button></div>
    </form>

    <section class="panel form">
      <h2 class="row"><ShieldCheck class="ic-gold" /> Two-step login</h2>
      <p class="muted">{{ totpOn ? "On. Logging in needs your password and a code from your phone." : "Off. Turn it on so a stolen password alone cannot get in." }}</p>
      <template v-if="!totpOn && !setup">
        <div class="row"><button class="btn gold" type="button" @click="startTotp"><Smartphone /> Set it up</button></div>
      </template>
      <template v-if="setup">
        <p>Scan this with an authenticator app (Google Authenticator, Authy, 1Password and the like), then type the 6-digit code it shows.</p>
        <img :src="setup.qr" alt="QR code for your authenticator app" width="200" height="200" class="qr" />
        <p class="muted small">Cannot scan? Enter this key by hand: <span class="mono">{{ setup.secret }}</span></p>
        <form class="row" @submit.prevent="enableTotp">
          <input v-model="code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" placeholder="123456" class="codein" aria-label="Code" required />
          <button class="btn gold" type="submit">Turn on</button>
        </form>
      </template>
      <form v-if="totpOn" class="row" @submit.prevent="disableTotp">
        <input v-model="code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" placeholder="code to turn it off" class="codein" aria-label="Code" required />
        <button class="btn danger" type="submit">Turn off</button>
      </form>
      <p v-if="totpMsg" class="muted" role="status">{{ totpMsg }}</p>
      <p v-if="totpErr" class="error" role="alert">{{ totpErr }}</p>
    </section>
  </main>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: 10px; max-width: 480px; }
.form p { margin: 0; }
.qr { border: 4px solid #fff; image-rendering: pixelated; }
.codein { width: 180px; font-family: var(--mono); letter-spacing: 0.2em; }
.small { font-size: 13px; }
</style>
