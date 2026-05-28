/// <reference types="vite/client" />

// Type-safe view of the Vite build-time env vars we read in app code.
// Anything not listed here is still accessible via `import.meta.env` but
// without strict typing.
interface ImportMetaEnv {
  /** Optional API origin for split-domain deploys (web on a different
   *  host than api). Empty / undefined = same-origin via Traefik. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
