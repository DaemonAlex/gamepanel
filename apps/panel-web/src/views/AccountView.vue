<script setup lang="ts">
import { ref } from "vue";
import { api } from "../api.js";
import { session } from "../session.js";

const current = ref("");
const next = ref("");
const again = ref("");
const message = ref("");
const error = ref("");
const busy = ref(false);

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
  </main>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: 10px; max-width: 480px; }
</style>
