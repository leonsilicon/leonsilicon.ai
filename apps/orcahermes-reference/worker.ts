import { serveSite, type Assets } from "@-/ai.leonsilicon.configs.cloudflare";

export default {
  async fetch(request: Request, env: { ASSETS: Assets }): Promise<Response> {
    return (await serveSite(request, env.ASSETS)) ?? new Response("Not found", { status: 404 });
  },
};
