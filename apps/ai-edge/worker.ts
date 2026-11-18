import { createEdge, type Upstream } from "@-/com.leonsilicon.ai.services.ai-edge";
import { serveSite, type Assets } from "@-/com.leonsilicon.www";

interface Env {
  /** Workers VPC service "ai-mini-gateway": the mini's gateway (127.0.0.1:18800) through tunnel ai-mini. */
  MINI: Upstream;
  /** The Vite build of www/ (dist/www): each service's page is www/ai/leonsilicon/<name>/index.html. */
  ASSETS: Assets;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await serveSite(request, env.ASSETS)) ?? createEdge(env.MINI)(request);
  },
};
