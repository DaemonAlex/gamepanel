<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { ApiError } from "../api.js";
import { session } from "../session.js";

const email = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);
const code = ref("");
const needCode = ref(false);
const route = useRoute();
const router = useRouter();

async function submit() {
  busy.value = true;
  error.value = "";
  try {
    await session.login(email.value.trim(), password.value, needCode.value ? code.value.trim() : undefined);
    const next = typeof route.query.next === "string" && route.query.next.startsWith("/") ? route.query.next : "/";
    await router.push(next);
  } catch (e) {
    if ((e as ApiError).data?.needCode) needCode.value = true;
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="login">
    <form class="panel" @submit.prevent="submit">
      <div class="row"><span class="pin running" aria-hidden="true"></span><h1>Daemon&rsquo;s Game Panel</h1></div>
      <p class="label">Spawn point</p>
      <label for="email" class="label">Email</label>
      <input id="email" v-model="email" type="email" autocomplete="username" required />
      <label for="password" class="label">Password</label>
      <input id="password" v-model="password" type="password" autocomplete="current-password" required />
      <template v-if="needCode">
        <label for="code" class="label">Code from your authenticator app</label>
        <input id="code" v-model="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required />
      </template>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button class="btn gold" type="submit" :disabled="busy">{{ busy ? "Logging in" : "Log in" }}</button>
    </form>
  </main>
</template>

<style scoped>
.login { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
form { width: min(380px, 100%); display: flex; flex-direction: column; gap: 10px; }
form .btn { justify-content: center; margin-top: 6px; }
</style>
