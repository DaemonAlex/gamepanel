<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import type { ServerType } from "@gamepanel/shared";
import { api } from "../api.js";

const types: { value: ServerType; label: string; note: string }[] = [
  { value: "PAPER", label: "Paper", note: "Plugins, fast. The usual choice." },
  { value: "VANILLA", label: "Vanilla", note: "Plain Minecraft." },
  { value: "PURPUR", label: "Purpur", note: "Paper with more settings." },
  { value: "FABRIC", label: "Fabric", note: "Light mods." },
  { value: "FORGE", label: "Forge", note: "Classic mods and modpacks." },
  { value: "NEOFORGE", label: "NeoForge", note: "Newer Forge mods." },
];

const name = ref("");
const type = ref<ServerType>("PAPER");
const version = ref("LATEST");
const memoryGb = ref(4);
const cpus = ref(2);
const eula = ref(false);
const error = ref("");
const busy = ref(false);
const router = useRouter();

// Same rule as the API, so the user sees the id before creating.
const id = computed(() =>
  name.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/g, ""),
);

async function create() {
  if (!eula.value) {
    error.value = "Tick the Minecraft EULA box to continue.";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const s = await api.create({
      name: name.value.trim(),
      type: type.value,
      version: version.value.trim().toUpperCase() === "LATEST" ? "LATEST" : version.value.trim(),
      memoryMb: Math.round(memoryGb.value * 1024),
      cpus: cpus.value,
      eulaAccepted: true,
    });
    await router.push(`/servers/${s.id}`);
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
      <h1>New server</h1>
      <p class="muted">It gets the next free port and starts right away. First start downloads the game, so give it a minute.</p>
    </div>

    <form class="panel form" @submit.prevent="create">
      <label for="name" class="label">Name</label>
      <input id="name" v-model="name" maxlength="40" required placeholder="Survival with friends" />
      <p class="muted small">Server id: <span class="mono">{{ id || "..." }}</span></p>

      <fieldset>
        <legend class="label">Type</legend>
        <div class="types">
          <label v-for="t in types" :key="t.value" class="type" :class="{ on: type === t.value }">
            <input v-model="type" type="radio" name="type" :value="t.value" />
            <span class="tname">{{ t.label }}</span>
            <span class="muted small">{{ t.note }}</span>
          </label>
        </div>
      </fieldset>

      <label for="version" class="label">Minecraft version</label>
      <input id="version" v-model="version" list="versions" required />
      <datalist id="versions">
        <option value="LATEST"></option>
        <option value="1.21.4"></option>
        <option value="1.21.1"></option>
        <option value="1.20.1"></option>
        <option value="1.19.2"></option>
        <option value="1.18.2"></option>
        <option value="1.16.5"></option>
        <option value="1.12.2"></option>
      </datalist>

      <label for="ram" class="label">RAM: {{ memoryGb }} GB</label>
      <input id="ram" v-model.number="memoryGb" type="range" min="1" max="16" step="0.5" />

      <label for="cpus" class="label">CPU cores</label>
      <select id="cpus" v-model.number="cpus">
        <option :value="1">1</option>
        <option :value="2">2</option>
        <option :value="3">3</option>
        <option :value="4">4</option>
      </select>

      <label class="eula">
        <input v-model="eula" type="checkbox" />
        <span>I accept the <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noopener">Minecraft EULA</a> for this server.</span>
      </label>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="row">
        <button class="btn gold" type="submit" :disabled="busy || !name.trim() || !eula">{{ busy ? "Placing waypoint" : "Create and start" }}</button>
        <RouterLink to="/" class="btn">Cancel</RouterLink>
      </div>
    </form>
  </main>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: 10px; max-width: 640px; }
.small { font-size: 14px; margin: 0; }
fieldset { border: 0; padding: 0; margin: 6px 0; }
.types { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; margin-top: 6px; }
.type { border: 1px solid var(--line); padding: 10px; display: flex; flex-direction: column; gap: 2px; cursor: pointer; background: var(--abyss); }
.type.on { border-color: var(--gold); box-shadow: inset 3px 0 0 var(--gold); }
.type input { position: absolute; opacity: 0; }
.type:focus-within { outline: 2px solid var(--gold); outline-offset: 2px; }
.tname { font-weight: 700; }
.eula { display: flex; gap: 10px; align-items: flex-start; margin: 8px 0; }
.eula input { width: auto; margin-top: 4px; }
input[type="range"] { padding: 0; accent-color: var(--gold); }
</style>
