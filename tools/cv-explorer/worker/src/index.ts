import { Hono } from "hono";
import { cors } from "hono/cors";
import { clipsRoute } from "./routes/clips";
import { audioRoute } from "./routes/audio";
import { datasetsRoute } from "./routes/datasets";

export type Env = {
  Bindings: {
    DB: D1Database;
    AUDIO: R2Bucket;
  };
};

const app = new Hono<Env>();

app.use("/api/*", cors());

app.route("/api", clipsRoute);
app.route("/api", audioRoute);
app.route("/api", datasetsRoute);

export default app;
