import { createGateway, ROUTES } from "@-/com.leonsilicon.ai.services.ai-gateway";

const port = Number(process.env.AI_GATEWAY_PORT ?? 18800);
const log = (event: string, fields: Record<string, unknown> = {}): void =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

const server = createGateway({ routes: ROUTES, publicSuffix: "leonsilicon.ai", log });
server.listen(port, "127.0.0.1", () =>
  log("listening", { port, routes: ROUTES.map((r) => r.name) }),
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => server.close(() => process.exit(0)));
