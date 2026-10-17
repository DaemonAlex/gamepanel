import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import { session } from "./session.js";
import DashboardView from "./views/DashboardView.vue";
import LoginView from "./views/LoginView.vue";
import NewServerView from "./views/NewServerView.vue";
import ServerView from "./views/ServerView.vue";
import "./style.css";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", component: LoginView, meta: { public: true } },
    { path: "/", component: DashboardView },
    { path: "/new", component: NewServerView },
    { path: "/servers/:id", component: ServerView, props: true },
  ],
});

router.beforeEach(async (to) => {
  await session.ready;
  if (!to.meta.public && !session.me.value) return { path: "/login", query: { next: to.fullPath } };
  if (to.path === "/login" && session.me.value) return "/";
  return true;
});

createApp(App).use(router).mount("#app");
