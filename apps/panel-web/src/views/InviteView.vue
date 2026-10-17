<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api.js";
import { session } from "../session.js";

const props = defineProps<{ token: string }>();
const router = useRouter();
const info = ref<{ email: string; kind: string } | null>(null);
const password = ref("");
const again = ref("");
const error = ref("");
const busy = ref(false);

onMounted(async () => {
  try {
    info.value = await api.inviteInfo(props.token);
  } catch (e) {
    error.value = (e as Error).message;
  }
});

async function accept() {
  error.value = "";
  if (password.value !== again.value) {
    error.value = "The two passwords are not the same.";
    return;
  }
  busy.value = true;
  try {
    session.me.value = await api.acceptInvite(props.token, password.value);
    await router.push("/");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="login">
    <form class="panel" @submit.prevent="accept">
      <div class="row"><span class="pin running" aria-hidden="true"></span><h1>Daemon&rsquo;s Game Panel</h1></div>
      <template v-if="info">
        <p>{{ info.kind === "reset" ? "Set a new password for" : "Welcome! Set a password for" }} <b>{{ info.email }}</b>.</p>
        <label for="pw1" class="label">Password (12 characters or more)</label>
        <input id="pw1" v-model="password" type="password" autocomplete="new-password" minlength="12" required />
        <label for="pw2" class="label">Same password again</label>
        <input id="pw2" v-model="again" type="password" autocomplete="new-password" minlength="12" required />
        <button class="btn gold" type="submit" :disabled="busy">{{ info.kind === "reset" ? "Save and log in" : "Join and log in" }}</button>
      </template>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </form>
  </main>
</template>

<style scoped>
.login { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
form { width: min(420px, 100%); display: flex; flex-direction: column; gap: 10px; }
form p { margin: 0; }
form .btn { justify-content: center; margin-top: 6px; }
</style>
