<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import type { ConsoleOut } from "@gamepanel/shared";
import { consoleUrl } from "../api.js";

const props = defineProps<{ id: string }>();
const MAX_LINES = 2000;
const lines = ref<{ n: number; text: string; notice?: boolean }[]>([]);
const input = ref("");
const history: string[] = [];
let historyAt = -1;
let counter = 0;
let ws: WebSocket | null = null;
const state = ref<"connecting" | "open" | "closed">("connecting");
const box = ref<HTMLElement | null>(null);
let follow = true;

function push(text: string, notice = false) {
  lines.value.push({ n: counter++, text, notice });
  if (lines.value.length > MAX_LINES) lines.value.splice(0, lines.value.length - MAX_LINES);
  if (follow) void nextTick(() => box.value && (box.value.scrollTop = box.value.scrollHeight));
}

function connect() {
  state.value = "connecting";
  ws = new WebSocket(consoleUrl(props.id));
  ws.onopen = () => (state.value = "open");
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as ConsoleOut;
    if (msg.t === "line") push(msg.line);
    else push(msg.text, true);
  };
  ws.onclose = () => {
    state.value = "closed";
  };
}

// Keep following new lines unless the reader scrolled up.
function onScroll() {
  const el = box.value;
  if (el) follow = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function send() {
  const cmd = input.value.trim().replace(/^\//, "");
  if (!cmd || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ t: "cmd", cmd }));
  push(`> ${cmd}`, true);
  history.unshift(cmd);
  history.splice(50);
  historyAt = -1;
  input.value = "";
}

function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowUp" && historyAt < history.length - 1) {
    historyAt++;
    input.value = history[historyAt] ?? "";
    e.preventDefault();
  } else if (e.key === "ArrowDown") {
    historyAt = Math.max(-1, historyAt - 1);
    input.value = historyAt === -1 ? "" : (history[historyAt] ?? "");
    e.preventDefault();
  }
}

onMounted(connect);
onUnmounted(() => ws?.close());
</script>

<template>
  <section class="console">
    <div class="row bar">
      <span class="label">Console</span>
      <span class="label" :class="state">{{ state }}</span>
      <button v-if="state === 'closed'" class="btn small" type="button" @click="connect">Reconnect</button>
    </div>
    <div ref="box" class="log mono" role="log" aria-live="off" @scroll="onScroll">
      <div v-for="l in lines" :key="l.n" :class="{ notice: l.notice }">{{ l.text }}</div>
    </div>
    <form class="row" @submit.prevent="send">
      <label for="cmd" class="sr">Command</label>
      <input id="cmd" v-model="input" class="mono" autocomplete="off" placeholder="say hello   (up arrow for history)" maxlength="1000" @keydown="onKey" />
      <button class="btn gold" type="submit" :disabled="state !== 'open'">Send</button>
    </form>
  </section>
</template>

<style scoped>
.console { display: flex; flex-direction: column; gap: 8px; }
.bar { justify-content: space-between; }
.open { color: var(--ok); }
.closed { color: var(--bad); }
.log {
  background: var(--abyss); border: 1px solid var(--line); border-left: 3px solid var(--gold);
  height: 420px; overflow: auto; padding: 10px 12px; font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere;
}
.notice { color: var(--gold); }
form input { flex: 1; min-width: 0; }
.btn.small { padding: 4px 10px; font-size: 13px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
@media (max-width: 560px) { .log { height: 320px; } }
</style>
