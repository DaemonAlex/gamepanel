<script setup lang="ts">
import { onMounted, ref } from "vue";
import { permLabels, serverPerms, type AccessView, type ServerPerm } from "@gamepanel/shared";
import { Pencil, Share2, Trash2, UserPlus } from "lucide-vue-next";
import { api } from "../api.js";

const props = defineProps<{ id: string }>();
const list = ref<AccessView[]>([]);
const error = ref("");
const email = ref("");
const perms = ref<ServerPerm[]>(["console", "power", "players", "logs"]);
const editing = ref<string | null>(null);

async function load() {
  try {
    list.value = await api.access(props.id);
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(load);

function toggle(p: ServerPerm) {
  perms.value = perms.value.includes(p) ? perms.value.filter((x) => x !== p) : [...perms.value, p];
}

async function save() {
  error.value = "";
  try {
    await api.setAccess(props.id, email.value.trim(), perms.value);
    email.value = "";
    editing.value = null;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function edit(a: AccessView) {
  email.value = a.email;
  perms.value = [...a.perms];
  editing.value = a.userId;
}

const describe = (a: AccessView) => (a.perms.length ? a.perms.map((p) => permLabels[p]).join(" · ") : "can only see it");

async function remove(a: AccessView) {
  await api.removeAccess(props.id, a.userId).catch((e: Error) => (error.value = e.message));
  await load();
}
</script>

<template>
  <article class="panel share">
    <p class="label"><Share2 />Who else can use this server</p>
    <form class="sform" @submit.prevent="save">
      <div class="row">
        <input v-model="email" type="email" required placeholder="their account email" class="grow" aria-label="Email" :readonly="!!editing" />
        <button class="btn gold" type="submit"><UserPlus /> {{ editing ? "Save rights" : "Share" }}</button>
        <button v-if="editing" class="btn" type="button" @click="(editing = null), (email = '')">Cancel</button>
      </div>
      <div class="perms" role="group" aria-label="What they may do">
        <button v-for="p in serverPerms" :key="p" type="button" :class="{ on: perms.includes(p) }" :aria-pressed="perms.includes(p)" @click="toggle(p)">{{ permLabels[p] }}</button>
      </div>
      <p class="muted small">They need an account first: an admin invites them on the People page.</p>
    </form>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-for="a in list" :key="a.userId" class="arow">
      <div class="grow">
        <p class="aname">{{ a.email }}</p>
        <p class="muted small">{{ describe(a) }}</p>
      </div>
      <button class="btn small" type="button" :aria-label="`Edit ${a.email}`" @click="edit(a)"><Pencil /></button>
      <button class="btn small danger" type="button" :aria-label="`Remove ${a.email}`" @click="remove(a)"><Trash2 /></button>
    </div>
    <p v-if="!list.length" class="muted small">Only you (and admins) can use it.</p>
  </article>
</template>

<style scoped>
.share { display: flex; flex-direction: column; gap: 10px; }
.sform { display: flex; flex-direction: column; gap: 8px; }
.grow { flex: 1; min-width: 200px; }
.perms { display: flex; flex-wrap: wrap; gap: 6px; }
.perms button { font: 600 12px var(--font); padding: 5px 10px; border: 1px solid var(--line); background: var(--abyss); color: var(--ink2); cursor: pointer; }
.perms button.on { background: var(--gold); color: var(--sea); border-color: var(--gold); }
.perms button:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.arow { display: flex; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--line-soft); flex-wrap: wrap; }
.aname { margin: 0; font-weight: 700; }
.small { font-size: 13px; margin: 2px 0 0; }
.btn.small { padding: 3px 9px; font-size: 12px; }
</style>
