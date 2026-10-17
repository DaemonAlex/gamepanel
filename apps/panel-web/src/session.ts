import { ref } from "vue";
import type { Me } from "@gamepanel/shared";
import { api } from "./api.js";

// Who is logged in. Checked once at start, then set by login and logout.
const me = ref<Me | null>(null);
const ready = api
  .me()
  .then((m) => {
    me.value = m;
  })
  .catch(() => {
    me.value = null;
  });

export const session = {
  me,
  ready,
  async login(email: string, password: string) {
    me.value = await api.login(email, password);
  },
  async logout() {
    await api.logout().catch(() => {});
    me.value = null;
  },
};
