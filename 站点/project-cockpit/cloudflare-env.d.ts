declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    BOOTSTRAP_TOKEN?: string;
    PUBLIC_ORIGIN?: string;
  }
}
