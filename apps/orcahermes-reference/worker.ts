import { serveSite, type Assets } from "@-/ai.leonsilicon.configs.cloudflare";
import installer from "./@assets/install.py";

export default {
  async fetch(request: Request, env: { ASSETS: Assets }): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.hostname === "orcahermes.leonsilicon.ai" &&
      url.pathname === "/install.py" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return new Response(request.method === "HEAD" ? null : installer, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": 'attachment; filename="install-orcahermes.py"',
          "cache-control": "no-cache",
        },
      });
    }
    return (await serveSite(request, env.ASSETS)) ?? new Response("Not found", { status: 404 });
  },
};
