/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Multiplayer server endpoint (e.g. http://localhost:8787 or wss://…).
   *  Defaults to same-origin when the game is served by the game server. */
  readonly VITE_MP_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
