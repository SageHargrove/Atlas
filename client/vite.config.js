import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";

/* Keep the previous build's chunks on disk instead of wiping them.

   The failure this fixes: a tab open from the previous deploy still references
   the old hashed filenames. Click something that triggers a dynamic import —
   the PDF builder, the PDF viewer — and the browser requests a chunk that the
   new build just deleted, giving "Failed to fetch dynamically imported module"
   and no way forward but a manual refresh the user has no reason to guess at.

   Old assets are pruned by age instead, so a session that was open across a
   deploy keeps working and the directory still can't grow forever. */
const KEEP_DAYS = 10;

function keepOldChunks() {
  return {
    name: "atlas-keep-old-chunks",
    closeBundle() {
      const dir = path.resolve(__dirname, "dist/assets");
      if (!fs.existsSync(dir)) return;
      const cutoff = Date.now() - KEEP_DAYS * 864e5;
      let removed = 0;
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        try { if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p); removed++; } } catch {}
      }
      if (removed) console.log("pruned " + removed + " asset(s) older than " + KEEP_DAYS + " days");
    },
  };
}

export default defineConfig({
  plugins: [react(), keepOldChunks()],
  build: {
    /* the whole point above — a clean wipe is what breaks open sessions */
    emptyOutDir: false,
  },
  server: { proxy: { "/api": "http://localhost:3001" } },
});
