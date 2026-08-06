import { createReadStream } from "fs";

import { streamFile } from "@agent-native/core/server";
import { defineEventHandler, setResponseStatus } from "h3";

import {
  PUBLIC_GENERATED_DIR,
  lookupPublicFile,
} from "../../../lib/public-media";

export default defineEventHandler(async (event) => {
  const filename = event.path.replace("/api/gen-preview/", "");
  const found = await lookupPublicFile(PUBLIC_GENERATED_DIR, filename);
  if (found.status === "forbidden") {
    setResponseStatus(event, 403);
    return { error: "Forbidden" };
  }
  if (found.status === "missing") {
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }
  return streamFile(createReadStream(found.filepath));
});
