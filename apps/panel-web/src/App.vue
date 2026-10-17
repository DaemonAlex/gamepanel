<script setup lang="ts">
import { useRouter } from "vue-router";
import { session } from "./session.js";

const router = useRouter();
async function logout() {
  await session.logout();
  await router.push("/login");
}
</script>

<template>
  <header v-if="session.me.value" class="top">
    <RouterLink to="/" class="brand">
      <span class="pin running" aria-hidden="true"></span>
      <span>Daemon&rsquo;s Game Panel</span>
    </RouterLink>
    <span class="label coords" aria-hidden="true">X 0 &middot; Z 0</span>
    <RouterLink to="/account" class="who muted">{{ session.me.value.email }} &middot; {{ session.me.value.role }}</RouterLink>
    <button class="btn" type="button" @click="logout">Log out</button>
  </header>
  <RouterView />
</template>

<style scoped>
.top {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  padding: 12px 16px; background: var(--deep); border-bottom: 1px solid var(--line);
  position: sticky; top: 0; z-index: 5;
}
.brand { display: flex; align-items: center; gap: 12px; color: var(--ink); text-decoration: none; font: 900 18px var(--font); }
.coords { flex: 1; }
.who { font-size: 14px; overflow-wrap: anywhere; }
@media (max-width: 560px) { .coords { display: none; } .who { flex: 1; } }
</style>
