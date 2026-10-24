<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { PlayerAction, PlayerRef, PlayersView } from "@gamepanel/shared";
import { Ban, Crown, DoorOpen, Gavel, MessageSquare, ShieldCheck, ShieldOff, UserMinus, UserPlus, Users, Earth } from "lucide-vue-next";
import { api } from "../api.js";

const props = defineProps<{ id: string }>();
const view = ref<PlayersView | null>(null);
const error = ref("");
const answer = ref("");
const busy = ref(false);
// In-page forms: which player has an open reason/message box, and for what.
const open = ref<{ name: string; action: "kick" | "ban" | "tell" } | null>(null);
const text = ref("");
const addName = ref("");
const opName = ref("");
const filter = ref("");
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
  try {
    view.value = await api.players(props.id);
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(() => {
  void load();
  timer = setInterval(() => document.visibilityState === "visible" && void load(), 10_000);
});
onUnmounted(() => clearInterval(timer));

const NAME = /^[A-Za-z0-9_]{1,16}$/;
const head = (p: PlayerRef) => `https://mc-heads.net/avatar/${encodeURIComponent(p.uuid ?? p.name)}/32`;
const lower = (s: string) => s.toLowerCase();
const isOp = (n: string) => !!view.value?.ops.some((o) => lower(o.name) === lower(n));
const isListed = (n: string) => !!view.value?.whitelist.some((o) => lower(o.name) === lower(n));
const isBanned = (n: string) => !!view.value?.banned.some((o) => lower(o.name) === lower(n));
const known = computed(() => {
  const q = lower(filter.value.trim());
  return (view.value?.known ?? []).filter((p) => !q || lower(p.name).includes(q)).slice(0, 50);
});
const when = (iso: string | null) => {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
};

async function act(a: PlayerAction) {
  if (!NAME.test(a.name)) {
    error.value = "That is not a Minecraft name (letters, digits and _ only, up to 16).";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    answer.value = (await api.playerAction(props.id, a)).answer || "Done.";
    open.value = null;
    text.value = "";
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function toggleWhitelist() {
  if (!view.value) return;
  busy.value = true;
  try {
    answer.value = (await api.setWhitelist(props.id, !view.value.whitelistOn)).answer;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function openBox(name: string, action: "kick" | "ban" | "tell") {
  open.value = { name, action };
  text.value = "";
}
</script>

<template>
  <section class="players">
    <p v-if="view && !view.running" class="panel muted">The server is stopped. Lists below come from its files; changes need it running.</p>
    <p v-if="answer" class="panel answer" role="status"><span class="label">Server says</span> {{ answer }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <article class="panel">
      <p class="label"><Users />Online now{{ view?.running ? ` (${view.online.length} of ${view.max})` : "" }}</p>
      <div v-if="view?.online.length" class="rows">
        <div v-for="p in view.online" :key="p.name" class="prow">
          <img :src="head(p)" alt="" width="32" height="32" loading="lazy" />
          <span class="pname">{{ p.name }}</span>
          <span v-if="isOp(p.name)" class="tag">op</span>
          <span class="acts">
            <button class="btn small" type="button" @click="openBox(p.name, 'tell')"><MessageSquare /> Message</button>
            <button class="btn small" type="button" @click="openBox(p.name, 'kick')"><DoorOpen /> Kick</button>
            <button class="btn small" type="button" :disabled="busy" @click="act({ action: isOp(p.name) ? 'deop' : 'op', name: p.name })"><ShieldOff v-if="isOp(p.name)" /><ShieldCheck v-else /> {{ isOp(p.name) ? "Deop" : "Op" }}</button>
            <button class="btn small danger" type="button" @click="openBox(p.name, 'ban')"><Ban /> Ban</button>
          </span>
          <form v-if="open?.name === p.name" class="row box" @submit.prevent="act({ action: open.action, name: p.name, text })">
            <label class="label" :for="`t-${p.name}`">{{ open.action === "tell" ? "Message" : "Reason (optional)" }}</label>
            <input :id="`t-${p.name}`" v-model="text" maxlength="200" class="grow" :required="open.action === 'tell'" />
            <button class="btn small" :class="open.action === 'ban' ? 'danger' : 'gold'" type="submit" :disabled="busy">
              {{ open.action === "ban" ? `Yes, ban ${p.name}` : open.action === "kick" ? "Kick" : "Send" }}
            </button>
            <button class="btn small" type="button" @click="open = null">Cancel</button>
          </form>
        </div>
      </div>
      <p v-else class="muted">{{ view?.running ? "Nobody online right now." : "-" }}</p>
    </article>

    <div class="cols">
      <article class="panel">
        <div class="row between">
          <p class="label"><ShieldCheck />Whitelist ({{ view?.whitelist.length ?? 0 }})</p>
          <button class="btn small" :class="view?.whitelistOn ? 'gold' : ''" type="button" :disabled="busy || !view?.running" @click="toggleWhitelist">
            {{ view?.whitelistOn ? "On: invite only" : "Off: anyone" }}
          </button>
        </div>
        <form class="row" @submit.prevent="act({ action: 'whitelist-add', name: addName.trim() }).then(() => (addName = ''))">
          <label for="wl-add" class="sr">Add to whitelist</label>
          <input id="wl-add" v-model="addName" placeholder="Minecraft name" maxlength="16" class="grow" />
          <button class="btn small gold" type="submit" :disabled="busy || !addName.trim()"><UserPlus /> Add</button>
        </form>
        <div class="rows">
          <div v-for="p in view?.whitelist ?? []" :key="p.name" class="prow">
            <img :src="head(p)" alt="" width="24" height="24" loading="lazy" />
            <span class="pname">{{ p.name }}</span>
            <button class="btn small" type="button" :disabled="busy" @click="act({ action: 'whitelist-remove', name: p.name })"><UserMinus /> Remove</button>
          </div>
        </div>
        <p v-if="view && !view.whitelist.length" class="muted small">Empty. Operators can still join.</p>
      </article>

      <article class="panel">
        <p class="label"><Crown />Operators ({{ view?.ops.length ?? 0 }})</p>
        <form class="row" @submit.prevent="act({ action: 'op', name: opName.trim() }).then(() => (opName = ''))">
          <label for="op-add" class="sr">Make operator</label>
          <input id="op-add" v-model="opName" placeholder="Minecraft name" maxlength="16" class="grow" />
          <button class="btn small gold" type="submit" :disabled="busy || !opName.trim()"><Crown /> Make op</button>
        </form>
        <div class="rows">
          <div v-for="p in view?.ops ?? []" :key="p.name" class="prow">
            <img :src="head(p)" alt="" width="24" height="24" loading="lazy" />
            <span class="pname">{{ p.name }}</span>
            <span class="tag">level {{ p.level }}</span>
            <button class="btn small" type="button" :disabled="busy" @click="act({ action: 'deop', name: p.name })"><ShieldOff /> Deop</button>
          </div>
        </div>
      </article>
    </div>

    <article class="panel">
      <p class="label"><Gavel />Banned ({{ view?.banned.length ?? 0 }} players, {{ view?.bannedIps.length ?? 0 }} addresses)</p>
      <div class="rows">
        <div v-for="p in view?.banned ?? []" :key="p.name" class="prow">
          <img :src="head(p)" alt="" width="24" height="24" loading="lazy" />
          <span class="pname">{{ p.name }}</span>
          <span class="muted small grow">{{ p.reason }}</span>
          <button class="btn small" type="button" :disabled="busy" @click="act({ action: 'pardon', name: p.name })"><Gavel /> Pardon</button>
        </div>
        <div v-for="b in view?.bannedIps ?? []" :key="b.ip" class="prow">
          <span class="pname mono">{{ b.ip }}</span>
          <span class="muted small grow">{{ b.reason }}</span>
        </div>
      </div>
      <p v-if="view && !view.banned.length && !view.bannedIps.length" class="muted small">Nobody is banned.</p>
    </article>

    <article class="panel">
      <div class="row between">
        <p class="label"><Earth />Everyone seen ({{ view?.known.length ?? 0 }})</p>
        <input v-model="filter" type="search" placeholder="Find a name" class="find" aria-label="Find a player" />
      </div>
      <div class="rows">
        <div v-for="p in known" :key="p.name" class="prow">
          <img :src="head(p)" alt="" width="24" height="24" loading="lazy" />
          <span class="pname">{{ p.name }}</span>
          <span class="muted small">last seen {{ when(p.lastSeen) }}</span>
          <span class="acts">
            <button v-if="!isListed(p.name)" class="btn small" type="button" :disabled="busy" @click="act({ action: 'whitelist-add', name: p.name })"><UserPlus /> Whitelist</button>
            <button v-if="!isOp(p.name)" class="btn small" type="button" :disabled="busy" @click="act({ action: 'op', name: p.name })"><Crown /> Op</button>
            <button v-if="!isBanned(p.name)" class="btn small danger" type="button" @click="openBox(p.name, 'ban')">Ban</button>
          </span>
          <form v-if="open?.name === p.name && open.action === 'ban'" class="row box" @submit.prevent="act({ action: 'ban', name: p.name, text })">
            <label class="label" :for="`k-${p.name}`">Reason (optional)</label>
            <input :id="`k-${p.name}`" v-model="text" maxlength="200" class="grow" />
            <button class="btn small danger" type="submit" :disabled="busy">Yes, ban {{ p.name }}</button>
            <button class="btn small" type="button" @click="open = null">Cancel</button>
          </form>
        </div>
      </div>
    </article>
  </section>
</template>

<style scoped>
.players { display: flex; flex-direction: column; gap: 14px; }
.answer { margin: 0; border-left: 4px solid var(--gold); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.cols .panel, .players > .panel { display: flex; flex-direction: column; gap: 10px; }
.between { justify-content: space-between; }
.between .label { margin: 0; }
.rows { display: flex; flex-direction: column; }
.prow { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-top: 1px solid var(--line-soft); flex-wrap: wrap; }
.prow img { image-rendering: pixelated; flex: none; }
.pname { font-weight: 700; min-width: 90px; }
.tag { font: 600 11px var(--mono); color: var(--gold); border: 1px solid var(--gold); padding: 1px 6px; }
.acts { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }
.box { width: 100%; background: var(--abyss); padding: 8px; }
.grow { flex: 1; min-width: 0; }
.btn.small { padding: 3px 9px; font-size: 12px; }
.small { font-size: 13px; }
.find { width: 200px; padding: 5px 8px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
