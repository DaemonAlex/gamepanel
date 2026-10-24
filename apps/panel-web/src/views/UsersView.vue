<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { InviteView, Role, UserView } from "@gamepanel/shared";
import { ArrowLeft, Check, Copy, KeyRound, Mail, ShieldCheck, UserCheck, UserX, UsersRound } from "lucide-vue-next";
import { api } from "../api.js";
import { copy } from "../format.js";
import { session } from "../session.js";

const users = ref<UserView[]>([]);
const invites = ref<InviteView[]>([]);
const error = ref("");
const email = ref("");
const role = ref<Role>("owner");
const link = ref<{ text: string; note: string } | null>(null);
const copied = ref(false);
const editing = ref<string | null>(null);
const quota = ref({ maxServers: 1, maxMemoryMb: 4096, maxDiskGb: 20 });

async function load() {
  try {
    [users.value, invites.value] = await Promise.all([api.users(), api.invites()]);
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(load);

const full = (path: string) => `${location.origin}${path}`;

async function invite() {
  error.value = "";
  try {
    const r = await api.invite(email.value.trim(), role.value);
    link.value = { text: full(r.path), note: `Send this to ${email.value.trim()}. It works once and runs out in 7 days.` };
    email.value = "";
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function reset(u: UserView) {
  try {
    const r = await api.resetLink(u.id);
    link.value = { text: full(r.path), note: `Send this to ${u.email} to set a new password. It works once and runs out in 7 days.` };
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function update(u: UserView, body: Parameters<typeof api.updateUser>[1]) {
  try {
    await api.updateUser(u.id, body);
    editing.value = null;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function startQuota(u: UserView) {
  quota.value = { ...u.quota };
  editing.value = u.id;
}

async function copyLink() {
  if (link.value) copied.value = await copy(link.value.text);
  setTimeout(() => (copied.value = false), 1500);
}

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
</script>

<template>
  <main class="wrap">
    <div>
      <RouterLink to="/" class="label"><ArrowLeft />All servers</RouterLink>
      <h1>People</h1>
      <p class="muted">Invite someone, set what they can use, reset a password.</p>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <form class="panel row" @submit.prevent="invite">
      <label for="inv-email" class="label"><Mail />Invite</label>
      <input id="inv-email" v-model="email" type="email" required placeholder="friend@example.com" class="grow" />
      <select v-model="role" aria-label="Role" class="role">
        <option value="owner">Owner: runs their own servers</option>
        <option value="subuser">Helper: only servers shared with them</option>
        <option value="admin">Admin: everything</option>
      </select>
      <button class="btn gold" type="submit">Make invite link</button>
    </form>

    <div v-if="link" class="panel linkbox">
      <p>{{ link.note }} There is no email from the panel: copy it into a message yourself.</p>
      <div class="row">
        <span class="mono grow linktext">{{ link.text }}</span>
        <button class="btn gold" type="button" @click="copyLink"><Check v-if="copied" /><Copy v-else /> {{ copied ? "Copied" : "Copy link" }}</button>
      </div>
    </div>

    <article class="panel">
      <p class="label"><UsersRound />Everyone ({{ users.length }})</p>
      <div v-for="u in users" :key="u.id" class="urow" :class="{ off: u.disabled }">
        <div class="grow">
          <p class="uname">{{ u.email }} <span class="tag">{{ u.role }}</span><span v-if="u.totpEnabled" class="tag ok" title="Two-step login is on"><ShieldCheck class="tiny" /> 2-step</span><span v-if="u.disabled" class="tag bad">off</span></p>
          <p class="muted small">
            joined {{ when(u.createdAt) }}
            <template v-if="u.role === 'owner'">
              &middot; {{ u.usage.servers }}/{{ u.quota.maxServers }} servers &middot; {{ u.usage.memoryMb }}/{{ u.quota.maxMemoryMb }} MB RAM &middot; {{ u.usage.diskGb }}/{{ u.quota.maxDiskGb }} GB disk
            </template>
          </p>
        </div>
        <template v-if="u.id !== session.me.value?.id">
          <button v-if="u.role === 'owner'" class="btn small" type="button" @click="startQuota(u)">Limits</button>
          <button class="btn small" type="button" @click="reset(u)"><KeyRound /> Reset link</button>
          <button class="btn small" :class="u.disabled ? '' : 'danger'" type="button" @click="update(u, { disabled: !u.disabled })">
            <UserCheck v-if="u.disabled" /><UserX v-else /> {{ u.disabled ? "Turn on" : "Turn off" }}
          </button>
        </template>
        <span v-else class="muted small">you</span>
        <form v-if="editing === u.id" class="row quota" @submit.prevent="update(u, { quota })">
          <label class="label">Servers <input v-model.number="quota.maxServers" type="number" min="0" max="100" /></label>
          <label class="label">RAM MB <input v-model.number="quota.maxMemoryMb" type="number" min="0" step="512" /></label>
          <label class="label">Disk GB <input v-model.number="quota.maxDiskGb" type="number" min="0" /></label>
          <button class="btn small gold" type="submit">Save limits</button>
          <button class="btn small" type="button" @click="editing = null">Cancel</button>
        </form>
      </div>
    </article>

    <article v-if="invites.length" class="panel">
      <p class="label"><Mail />Links sent</p>
      <div v-for="(i, n) in invites" :key="n" class="urow">
        <span class="grow">{{ i.email }} <span class="tag">{{ i.kind }}</span></span>
        <span class="muted small">{{ i.usedAt ? `used ${when(i.usedAt)}` : new Date(i.expiresAt) < new Date() ? "ran out" : `open until ${when(i.expiresAt)}` }}</span>
      </div>
    </article>
  </main>
</template>

<style scoped>
.grow { flex: 1; min-width: 200px; }
.role { width: auto; }
.linkbox { border-left: 4px solid var(--gold); display: flex; flex-direction: column; gap: 8px; }
.linkbox p { margin: 0; }
.linktext { overflow-wrap: anywhere; background: var(--abyss); padding: 8px; }
.urow { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 8px 0; border-top: 1px solid var(--line-soft); }
.urow.off { opacity: 0.6; }
.uname { margin: 0; font-weight: 700; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.small { font-size: 13px; margin: 2px 0 0; }
.tag { font: 600 10px var(--mono); color: var(--ink2); border: 1px solid var(--line); padding: 0 5px; text-transform: uppercase; display: inline-flex; gap: 3px; align-items: center; }
.tag.ok { color: var(--ok); border-color: var(--ok); }
.tag.bad { color: var(--bad); border-color: var(--bad); }
.tiny { width: 11px; height: 11px; }
.quota { width: 100%; background: var(--abyss); padding: 8px; }
.quota input { width: 110px; padding: 5px 8px; margin-left: 6px; }
.btn.small { padding: 3px 9px; font-size: 12px; }
</style>
