import { auth, trustedOrigins } from "./auth";
import { createApp } from "./app";

const app = createApp(auth, trustedOrigins);
const port = Number(process.env.PORT ?? 8787);

console.log(`botcortex-api listening on http://localhost:${port}`);

export default { port, fetch: app.fetch };
