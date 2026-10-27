import { env } from 'cloudflare:workers';
import { handleApi } from '../../../server/worker-api.mjs';

export const GET = (request: Request) => handleApi(request, env);
export const POST = (request: Request) => handleApi(request, env);
export const PATCH = (request: Request) => handleApi(request, env);
export const DELETE = (request: Request) => handleApi(request, env);
export const PUT = (request: Request) => handleApi(request, env);
