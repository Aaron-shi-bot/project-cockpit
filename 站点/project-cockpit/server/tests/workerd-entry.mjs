// Isolated workerd regression entry. Bind DB/BUCKET and LOCAL_WORKER_TEST=1 in
// a temporary local Wrangler configuration, never the production manifest.
import { handleApi } from '../worker-api.mjs';
export default { fetch: (request, env, context) => handleApi(request, env, context) };
