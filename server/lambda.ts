import { handle } from "hono/aws-lambda";
import { store } from "./store";
import { createSupervisedCreationApp } from "../supervised/dispatch/routes";
export const handler = handle(
  createSupervisedCreationApp(store, {
    enabled: process.env.SUPERVISED_EXECUTION_ENABLED === "true",
  }),
);
