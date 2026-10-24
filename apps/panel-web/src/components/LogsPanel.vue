<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { LogFile, LogRead } from "@gamepanel/shared";
import { Download, FileExclamationPoint, ScrollText, Search } from "lucide-vue-next";
import { api, files as fileApi } from "../api.js";

const props = defineProps<{ id: string }>();
const list = ref<LogFile[]>([]);
const picked = ref("logs/latest.log");
const q = ref("");
const read = ref<LogRead | null>(null);
const error = ref("");
const loading = ref(false);

async function loadList() {
  try {
    list.value = await api.logs(props.id);
    if (list.value.length && !list.value.some((l) => l.path === picked.value)) picked.value = list.value[0]!.path;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function open() {
  loading.value = true;
  error.value = "";
  try {
    read.value = await api.readLog(props.id, picked.value, q.value.trim());
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await loadList();
  if (list.value.length) await open();
});

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const lineClass = (t: string) => (/\b(ERROR|FATAL|SEVERE)\b|Exception/.test(t) ? "err" : /\bWARN\b/.test(t) ? "warn" : "");
</script>

<template>
  <section class="logs">
    <form class="panel row" @submit.prevent="open">
      <label for="logfile" class="label"><ScrollText />Log</label>
      <select id="logfile" v-model="picked" class="pick" @change="open">
        <option v-for="l in list" :key="l.path" :value="l.path">{{ l.kind === "crash" ? "Crash report: " : "" }}{{ l.path.split("/").pop() }} ({{ when(l.modified) }})</option>
      </select>
      <input v-model="q" class="grow" placeholder="Search, e.g. ERROR or a player name" aria-label="Search the log" />
      <button class="btn gold" type="submit" :disabled="loading"><Search /> {{ q.trim() ? "Search" : "Show" }}</button>
      <a class="btn" :href="fileApi.downloadUrl(id, picked)"><Download /> Download</a>
    </form>

    <p v-if="list.some((l) => l.kind === 'crash')" class="panel crash"><FileExclamationPoint class="ic-bad" /> {{ list.filter((l) => l.kind === "crash").length }} crash report(s). Pick one from the list.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!list.length" class="panel muted">No logs yet. They appear once the server has started.</p>

    <template v-if="read">
      <p class="muted small">
        {{ q.trim() ? `${read.matched} matching line${read.matched === 1 ? "" : "s"} of ${read.total}` : `${read.total} lines` }}
        <span v-if="read.truncated"> &middot; showing the last {{ read.lines.length }}</span>
      </p>
      <div class="view mono" role="log">
        <div v-for="[n, t] in read.lines" :key="n" class="line" :class="lineClass(t)"><span class="n">{{ n }}</span><span>{{ t }}</span></div>
        <p v-if="!read.lines.length" class="muted">Nothing matches.</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.logs { display: flex; flex-direction: column; gap: 12px; }
.pick { width: auto; max-width: 340px; }
.grow { flex: 1; min-width: 180px; }
.crash { margin: 0; display: flex; gap: 10px; align-items: center; border-color: var(--bad); }
.small { font-size: 13px; margin: 0; }
.view { background: var(--abyss); border: 1px solid var(--line); border-left: 3px solid var(--gold); max-height: 560px; overflow: auto; padding: 8px 0; font-size: 12.5px; line-height: 1.5; }
.line { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 10px; padding: 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.line .n { color: var(--ink2); opacity: 0.6; text-align: right; user-select: none; }
.line.err { color: var(--bad); }
.line.warn { color: var(--warn); }
</style>
